/**
 * One-file encode pipeline: from a SINGLE source video, generate the lower
 * resolution renditions with ffmpeg, upload everything to OneDrive and
 * register the sources in the database. The viewer's quality menu then offers
 * every rendition — you never upload each encode by hand.
 *
 * Usage:
 *   npm run encode -- --slug <movie-slug> --ep <number> --input "D:\phim\file.mkv"
 *   npm run encode -- --slug <movie-slug> --ep <number> --from-onedrive "Movies/silo/e01.mp4"
 *
 * Options:
 *   --season <n>        Season number (default 1)
 *   --dest <folder>     OneDrive destination folder (default "Movies/<slug>")
 *   --resolutions a,b   Limit generated rungs, e.g. "720p,360p"
 *   --crf <n>           x264 quality (default 22, lower = better/bigger)
 *
 * Requirements:
 *   - ffmpeg + ffprobe on PATH (Windows: winget install Gyan.FFmpeg)
 *   - DATABASE_URL (sources are written to episode_sources)
 *   - OneDrive configured with WRITE permission (Files.ReadWrite.All)
 *   - The movie (and ideally the episode) already created in /admin
 *
 * Why not transcode on the server: encoding a movie needs hours of CPU and
 * the whole file on disk — far beyond serverless limits, and our streaming
 * rule forbids video bytes passing through functions. Encoding runs once on
 * your machine; the web then serves static files from the OneDrive CDN.
 */
import { config } from "dotenv";
config({ path: [".env.development.local", ".env.local", ".env"], quiet: true });

import { spawnSync } from "node:child_process";
import { closeSync, createWriteStream, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "../src/server/db/schema";
import {
  driveBase,
  getAccessToken,
  getDownloadInfo,
  isOneDriveConfigured,
} from "../src/server/onedrive/client";

type Resolution = "2160p" | "1080p" | "720p" | "360p";

const LADDER: { res: Resolution; height: number }[] = [
  { res: "2160p", height: 2160 },
  { res: "1080p", height: 1080 },
  { res: "720p", height: 720 },
  { res: "360p", height: 360 },
];

// ---------------------------------------------------------------- arguments

function readArgs(): Map<string, string> {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1] ?? "");
  }
  return args;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------ ffmpeg

function ensureFfmpeg(): void {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const probe = spawnSync(bin, ["-version"], { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
      fail(
        `Không tìm thấy ${bin}. Cài ffmpeg trước:\n` +
          `  Windows : winget install Gyan.FFmpeg  (mở terminal mới sau khi cài)\n` +
          `  macOS   : brew install ffmpeg\n` +
          `  Linux   : sudo apt install ffmpeg`,
      );
    }
  }
}

function ffprobeValue(file: string, args: string[]): string {
  const result = spawnSync("ffprobe", ["-v", "error", ...args, "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`ffprobe đọc file thất bại: ${result.stderr}`);
  return result.stdout.trim();
}

function runFfmpeg(args: string[], label: string): void {
  console.log(`\n▶ ffmpeg: ${label}`);
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-stats", ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`ffmpeg thất bại ở bước: ${label}`);
}

// ---------------------------------------------------------------- OneDrive

function encodeRemotePath(remotePath: string): string {
  return remotePath.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

/** Resumable upload via Graph upload session (10 MiB chunks). */
async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  const token = await getAccessToken();
  const sessionRes = await fetch(
    `${driveBase()}/root:/${encodeRemotePath(remotePath)}:/createUploadSession`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    },
  );
  if (!sessionRes.ok) {
    const detail = await sessionRes.text().catch(() => "");
    if (sessionRes.status === 403) {
      fail(
        `OneDrive từ chối upload (403) — app cần quyền Files.ReadWrite.All (xem SETUP.md mục 4).\n${detail.slice(0, 300)}`,
      );
    }
    fail(`Tạo upload session thất bại (${sessionRes.status}): ${detail.slice(0, 300)}`);
  }
  const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string };

  const size = statSync(localPath).size;
  const chunkSize = 10 * 1024 * 1024; // multiple of 320 KiB, per Graph docs
  const fd = openSync(localPath, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      const end = offset + length - 1;
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${end}/${size}`,
        },
        body: buffer,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        fail(`Upload chunk thất bại (${res.status}): ${detail.slice(0, 300)}`);
      }
      offset += length;
      const pct = Math.round((offset / size) * 100);
      process.stdout.write(`\r  ↑ ${remotePath} — ${pct}% (${Math.round(offset / 1e6)}/${Math.round(size / 1e6)} MB)`);
    }
    process.stdout.write("\n");
  } finally {
    closeSync(fd);
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const args = readArgs();
  const slug = args.get("slug") ?? fail("Thiếu --slug <movie-slug>");
  const epNumber = Number(args.get("ep") ?? fail("Thiếu --ep <số tập>"));
  const season = Number(args.get("season") ?? 1);
  const input = args.get("input");
  const fromOneDrive = args.get("from-onedrive");
  const dest = args.get("dest") ?? `Movies/${slug}`;
  const crf = String(Number(args.get("crf")) || 22);
  const onlyRes = args.get("resolutions")?.split(",").map((r) => r.trim());

  if (!input && !fromOneDrive) fail("Cần --input <file local> hoặc --from-onedrive <path>");
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL chưa có — chạy `vercel env pull .env.local` trước (script ghi nguồn vào DB).");
  }
  if (!isOneDriveConfigured()) {
    fail("OneDrive chưa cấu hình (MS_CLIENT_ID + MS_REFRESH_TOKEN hoặc MS_TENANT_ID) — xem SETUP.md mục 4.");
  }
  ensureFfmpeg();

  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  // Movie + episode must be resolvable up front so we fail before encoding.
  const movie = (
    await db.select().from(schema.movies).where(eq(schema.movies.slug, slug)).limit(1)
  )[0];
  if (!movie) fail(`Không tìm thấy phim slug "${slug}" — tạo phim trong /admin trước.`);

  const tempDir = mkdtempSync(path.join(tmpdir(), "phimverse-encode-"));
  try {
    // 1. Obtain the source file locally.
    let sourceFile: string;
    if (fromOneDrive) {
      console.log(`⬇ Tải bản gốc từ OneDrive: ${fromOneDrive}`);
      const info = await getDownloadInfo({ path: fromOneDrive });
      const res = await fetch(info.downloadUrl);
      if (!res.ok || !res.body) fail(`Tải bản gốc thất bại (${res.status})`);
      sourceFile = path.join(tempDir, "source");
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(sourceFile));
    } else {
      sourceFile = input!;
      try {
        statSync(sourceFile);
      } catch {
        fail(`Không thấy file: ${sourceFile}`);
      }
    }

    // 2. Probe height/duration to build the rendition ladder (never upscale).
    const height = Number(ffprobeValue(sourceFile, ["-select_streams", "v:0", "-show_entries", "stream=height"]));
    const durationMin = Math.round(Number(ffprobeValue(sourceFile, ["-show_entries", "format=duration"])) / 60);
    if (!height) fail("Không đọc được độ phân giải video từ file nguồn.");

    const topRung = LADDER.find((l) => height >= l.height * 0.92) ?? LADDER[LADDER.length - 1];
    let lowerRungs = LADDER.filter((l) => l.height < topRung.height);
    if (onlyRes) lowerRungs = lowerRungs.filter((l) => onlyRes.includes(l.res));
    console.log(
      `\n📼 Nguồn: ${height}p → bản gốc = ${topRung.res}, encode thêm: ${lowerRungs.map((l) => l.res).join(", ") || "(không có)"}`,
    );

    const fileName = `s${season}e${epNumber}.mp4`;
    const uploads: { res: Resolution; remotePath: string }[] = [];

    // 3. Top rung: remux the original (lossless, +faststart for instant seeking).
    if (fromOneDrive) {
      // Already on OneDrive — reuse it as-is for the top rung.
      uploads.push({ res: topRung.res, remotePath: fromOneDrive.replace(/^\/+/, "") });
      console.log(`✓ Bản gốc giữ nguyên trên OneDrive (${topRung.res})`);
    } else {
      const remuxed = path.join(tempDir, `top-${fileName}`);
      runFfmpeg(["-y", "-i", sourceFile, "-c", "copy", "-movflags", "+faststart", remuxed],
        `remux bản gốc ${topRung.res} (không mất chất lượng)`);
      const remotePath = `${dest}/${topRung.res}/${fileName}`;
      await uploadFile(remuxed, remotePath);
      uploads.push({ res: topRung.res, remotePath });
    }

    // 4. Lower rungs: encode + upload.
    for (const rung of lowerRungs) {
      const out = path.join(tempDir, `${rung.res}-${fileName}`);
      runFfmpeg(
        [
          "-y", "-i", sourceFile,
          "-vf", `scale=-2:${rung.height}`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart",
          out,
        ],
        `encode ${rung.res}`,
      );
      const remotePath = `${dest}/${rung.res}/${fileName}`;
      await uploadFile(out, remotePath);
      uploads.push({ res: rung.res, remotePath });
      rmSync(out, { force: true }); // free disk as we go
    }

    // 5. Register sources in the database (episode is created if missing).
    let episode = (
      await db
        .select()
        .from(schema.episodes)
        .where(
          and(
            eq(schema.episodes.movieId, movie.id),
            eq(schema.episodes.season, season),
            eq(schema.episodes.number, epNumber),
          ),
        )
        .limit(1)
    )[0];
    if (!episode) {
      episode = (
        await db
          .insert(schema.episodes)
          .values({
            movieId: movie.id,
            season,
            number: epNumber,
            title: movie.type === "series" ? `Tập ${epNumber}` : "Bản Full",
            duration: durationMin,
          })
          .returning()
      )[0];
      console.log(`\n＋ Đã tạo tập ${epNumber} (${durationMin} phút)`);
    } else if (episode.duration === 0 && durationMin > 0) {
      await db
        .update(schema.episodes)
        .set({ duration: durationMin })
        .where(eq(schema.episodes.id, episode.id));
    }

    for (const upload of uploads) {
      await db
        .insert(schema.episodeSources)
        .values({
          episodeId: episode.id,
          resolution: upload.res,
          sourceType: "mp4",
          oneDrivePath: upload.remotePath,
        })
        .onConflictDoUpdate({
          target: [schema.episodeSources.episodeId, schema.episodeSources.resolution],
          set: { oneDrivePath: upload.remotePath, sourceType: "mp4" },
        });
    }

    console.log(`\n✅ Hoàn tất: ${movie.title} — tập ${epNumber}`);
    for (const upload of uploads) console.log(`   ${upload.res.padEnd(6)} → ${upload.remotePath}`);
    console.log("Cache trang chi tiết tự làm mới trong ~5 phút (hoặc bấm Lưu phim trong /admin để làm mới ngay).");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ Encode pipeline lỗi:", err);
  process.exit(1);
});
