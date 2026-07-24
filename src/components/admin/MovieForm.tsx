"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { saveMovieAction, type AdminActionState } from "@/server/actions/admin.actions";
import type {
  AdminEpisodeInput,
  AdminMovieDetail,
  AdminSourceInput,
} from "@/server/repositories/types";
import { COUNTRIES, GENRES, RESOLUTIONS } from "@/lib/constants";
import { cn, slugify } from "@/lib/utils";

interface MovieFormProps {
  /** Existing movie for edit mode; null for create mode. */
  initial: AdminMovieDetail | null;
}

const inputClass =
  "h-10 w-full rounded-lg border border-line bg-night-800 px-3 text-sm text-ink outline-none transition-colors placeholder:text-dim/40 focus:border-gold";
const labelClass = "mb-1.5 block text-[13px] font-semibold text-ink";

function newSource(resolution: AdminSourceInput["resolution"]): AdminSourceInput {
  return { resolution, sourceType: "mp4", oneDrivePath: null, fallbackUrl: null };
}

function newEpisode(number: number): AdminEpisodeInput {
  return { season: 1, number, title: "", duration: 0, sources: [newSource("1080p")] };
}

export function MovieForm({ initial }: MovieFormProps) {
  const [state, formAction, pending] = useActionState<AdminActionState, FormData>(
    saveMovieAction,
    {},
  );

  const movie = initial?.movie ?? null;
  const [title, setTitle] = useState(movie?.title ?? "");
  const [slug, setSlug] = useState(movie?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(movie));
  const [type, setType] = useState<"single" | "series">(movie?.type ?? "single");
  const [episodes, setEpisodes] = useState<AdminEpisodeInput[]>(
    initial?.episodes?.length ? initial.episodes : [newEpisode(1)],
  );

  const effectiveSlug = slugTouched && slug ? slug : slugify(title);
  const episodesJson = useMemo(() => JSON.stringify(episodes), [episodes]);

  const updateEpisode = (index: number, patch: Partial<AdminEpisodeInput>) => {
    setEpisodes((prev) => prev.map((ep, i) => (i === index ? { ...ep, ...patch } : ep)));
  };

  const addEpisode = () => {
    setEpisodes((prev) => [...prev, newEpisode(prev.length + 1)]);
  };

  const removeEpisode = (index: number) => {
    setEpisodes((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  };

  const updateSource = (
    epIndex: number,
    srcIndex: number,
    patch: Partial<AdminSourceInput>,
  ) => {
    setEpisodes((prev) =>
      prev.map((ep, i) =>
        i === epIndex
          ? { ...ep, sources: ep.sources.map((s, j) => (j === srcIndex ? { ...s, ...patch } : s)) }
          : ep,
      ),
    );
  };

  const addSource = (epIndex: number) => {
    setEpisodes((prev) =>
      prev.map((ep, i) => {
        if (i !== epIndex) return ep;
        const used = new Set(ep.sources.map((s) => s.resolution));
        const free = RESOLUTIONS.find((r) => !used.has(r.value));
        if (!free) return ep; // every resolution already present
        return { ...ep, sources: [...ep.sources, newSource(free.value)] };
      }),
    );
  };

  const removeSource = (epIndex: number, srcIndex: number) => {
    setEpisodes((prev) =>
      prev.map((ep, i) =>
        i === epIndex ? { ...ep, sources: ep.sources.filter((_, j) => j !== srcIndex) } : ep,
      ),
    );
  };

  const switchType = (next: "single" | "series") => {
    setType(next);
    // A single movie has exactly one "Bản Full" episode.
    if (next === "single") setEpisodes((prev) => [prev[0] ?? newEpisode(1)]);
  };

  return (
    <form action={formAction} className="space-y-8">
      {movie && <input type="hidden" name="id" value={movie.id} />}
      <input type="hidden" name="episodes" value={episodesJson} />

      {/* Basic info */}
      <section className="rounded-2xl border border-line bg-night-900/60 p-5">
        <h2 className="heading-section mb-4 text-base">Thông tin phim</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Tên phim (tiếng Việt) *</span>
            <input
              name="title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Phàm Nhân Tu Tiên Truyện"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Tên gốc</span>
            <input
              name="originalTitle"
              defaultValue={movie?.originalTitle ?? ""}
              placeholder="The Immortal Ascension"
              className={inputClass}
            />
          </label>
          <label className="block md:col-span-2">
            <span className={labelClass}>Slug (đường dẫn)</span>
            <input
              name="slug"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="tự tạo từ tên phim"
              className={cn(inputClass, "font-mono")}
            />
          </label>
          <label className="block md:col-span-2">
            <span className={labelClass}>Nội dung phim</span>
            <textarea
              name="description"
              rows={4}
              defaultValue={movie?.description ?? ""}
              placeholder="Tóm tắt nội dung..."
              className={cn(inputClass, "h-auto py-2.5 leading-relaxed")}
            />
          </label>

          <label className="block">
            <span className={labelClass}>Loại phim *</span>
            <select
              name="type"
              value={type}
              onChange={(e) => switchType(e.target.value as "single" | "series")}
              className={inputClass}
            >
              <option value="single">Phim Lẻ</option>
              <option value="series">Phim Bộ</option>
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Quốc gia *</span>
            <select name="country" defaultValue={movie?.country ?? "us"} className={inputClass}>
              {Object.entries(COUNTRIES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Năm sản xuất *</span>
            <input
              name="year"
              type="number"
              required
              min={1900}
              max={2100}
              defaultValue={movie?.year ?? new Date().getFullYear()}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Thời lượng (phút{type === "series" ? "/tập" : ""})</span>
            <input
              name="duration"
              type="number"
              min={0}
              defaultValue={movie?.duration ?? 0}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Chất lượng</span>
            <select name="quality" defaultValue={movie?.quality ?? "FHD"} className={inputClass}>
              {["4K", "FHD", "HD", "CAM"].map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Điểm đánh giá (0–10)</span>
            <input
              name="rating"
              type="number"
              step="0.1"
              min={0}
              max={10}
              defaultValue={movie?.rating ?? 7}
              className={inputClass}
            />
          </label>
        </div>

        <label className="mt-4 flex items-center gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            name="featured"
            defaultChecked={movie?.featured ?? false}
            className="size-4 accent-gold"
          />
          Đưa vào mục <span className="font-semibold text-gold">Phim Đề Cử</span> (hero banner)
        </label>
      </section>

      {/* Genres */}
      <section className="rounded-2xl border border-line bg-night-900/60 p-5">
        <h2 className="heading-section mb-4 text-base">Thể loại *</h2>
        <div className="flex flex-wrap gap-2">
          {GENRES.map((genre) => (
            <label
              key={genre.slug}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-line bg-night-800 px-3.5 py-2 text-sm text-dim transition-colors has-checked:border-gold/60 has-checked:text-gold"
            >
              <input
                type="checkbox"
                name="genres"
                value={genre.slug}
                defaultChecked={movie?.genres.some((g) => g.slug === genre.slug) ?? false}
                className="size-3.5 accent-gold"
              />
              {genre.name}
            </label>
          ))}
        </div>
      </section>

      {/* Artwork */}
      <section className="rounded-2xl border border-line bg-night-900/60 p-5">
        <h2 className="heading-section mb-4 text-base">Hình ảnh</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={labelClass}>URL Poster (dọc 2:3)</span>
            <input
              name="posterUrl"
              defaultValue={movie?.posterUrl ?? ""}
              placeholder="/posters/ten-phim.jpg hoặc URL Blob/CDN"
              className={cn(inputClass, "font-mono text-xs")}
            />
          </label>
          <label className="block">
            <span className={labelClass}>URL Backdrop (ngang 16:9)</span>
            <input
              name="backdropUrl"
              defaultValue={movie?.backdropUrl ?? ""}
              placeholder="/backdrops/ten-phim.jpg hoặc URL Blob/CDN"
              className={cn(inputClass, "font-mono text-xs")}
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-dim">
          Để trống sẽ dùng ảnh mặc định. Có thể upload lên Vercel Blob qua{" "}
          <code className="rounded bg-night-800 px-1.5 py-0.5">POST /api/upload</code> rồi dán URL.
        </p>
      </section>

      {/* Episodes */}
      <section className="rounded-2xl border border-line bg-night-900/60 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="heading-section text-base">
            {type === "series" ? `Danh sách tập (${episodes.length})` : "Nguồn phát"}
          </h2>
          {type === "series" && (
            <button
              type="button"
              onClick={addEpisode}
              className="flex items-center gap-1.5 rounded-full border border-gold/50 px-3.5 py-1.5 text-sm font-semibold text-gold transition-colors hover:bg-gold/10"
            >
              <Plus className="size-4" /> Thêm tập
            </button>
          )}
        </div>

        <div className="space-y-4">
          {episodes.map((ep, epIndex) => (
            <div key={epIndex} className="rounded-xl border border-line/70 bg-night-800/50 p-3">
              {/* Episode meta */}
              <div className="grid gap-3 md:grid-cols-[80px_1fr_100px_44px]">
                <label className="block">
                  <span className={labelClass}>Tập</span>
                  <input
                    type="number"
                    min={1}
                    value={ep.number}
                    onChange={(e) => updateEpisode(epIndex, { number: Number(e.target.value) })}
                    className={inputClass}
                    disabled={type === "single"}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Tiêu đề tập</span>
                  <input
                    value={ep.title}
                    onChange={(e) => updateEpisode(epIndex, { title: e.target.value })}
                    placeholder={type === "series" ? `Tập ${ep.number}` : "Bản Full"}
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Phút</span>
                  <input
                    type="number"
                    min={0}
                    value={ep.duration || ""}
                    onChange={(e) => updateEpisode(epIndex, { duration: Number(e.target.value) })}
                    className={inputClass}
                  />
                </label>
                <div className="flex items-end pb-0.5">
                  {type === "series" && (
                    <button
                      type="button"
                      onClick={() => removeEpisode(epIndex)}
                      disabled={episodes.length <= 1}
                      aria-label={`Xóa tập ${ep.number}`}
                      className="grid size-10 place-items-center rounded-lg border border-line text-dim transition-colors hover:border-neon/60 hover:text-neon disabled:opacity-40"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Per-resolution sources */}
              <div className="mt-3 space-y-2 border-t border-line/60 pt-3">
                {ep.sources.map((source, srcIndex) => (
                  <div
                    key={srcIndex}
                    className="grid gap-2 md:grid-cols-[110px_90px_1fr_1fr_40px]"
                  >
                    <label className="block">
                      <span className={labelClass}>Độ phân giải</span>
                      <select
                        value={source.resolution}
                        onChange={(e) =>
                          updateSource(epIndex, srcIndex, {
                            resolution: e.target.value as AdminSourceInput["resolution"],
                          })
                        }
                        className={inputClass}
                      >
                        {RESOLUTIONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelClass}>Định dạng</span>
                      <select
                        value={source.sourceType}
                        onChange={(e) =>
                          updateSource(epIndex, srcIndex, {
                            sourceType: e.target.value as "mp4" | "hls",
                          })
                        }
                        className={inputClass}
                      >
                        <option value="mp4">MP4</option>
                        <option value="hls">HLS</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelClass}>OneDrive path</span>
                      <input
                        value={source.oneDrivePath ?? ""}
                        onChange={(e) =>
                          updateSource(epIndex, srcIndex, { oneDrivePath: e.target.value || null })
                        }
                        placeholder="Movies/ten-phim/2160p/e01.mp4"
                        className={cn(inputClass, "font-mono text-xs")}
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>URL dự phòng</span>
                      <input
                        value={source.fallbackUrl ?? ""}
                        onChange={(e) =>
                          updateSource(epIndex, srcIndex, { fallbackUrl: e.target.value || null })
                        }
                        placeholder="https://..."
                        className={cn(inputClass, "font-mono text-xs")}
                      />
                    </label>
                    <div className="flex items-end pb-0.5">
                      <button
                        type="button"
                        onClick={() => removeSource(epIndex, srcIndex)}
                        aria-label="Xóa độ phân giải này"
                        className="grid size-10 place-items-center rounded-lg border border-line text-dim transition-colors hover:border-neon/60 hover:text-neon"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
                {ep.sources.length < RESOLUTIONS.length && (
                  <button
                    type="button"
                    onClick={() => addSource(epIndex)}
                    className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-dim transition-colors hover:border-gold/50 hover:text-gold"
                  >
                    <Plus className="size-3.5" /> Thêm độ phân giải
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          <span className="font-semibold text-gold">Chỉ cần 1 file:</span> điền một nguồn duy nhất
          (bản gốc) là phát được — hoặc để trống rồi chạy{" "}
          <code className="rounded bg-night-800 px-1.5 py-0.5">npm run encode</code> ở máy để tự
          encode + upload các độ phân giải thấp hơn lên OneDrive và tự điền vào đây. Dòng nào bỏ
          trống cả hai ô nguồn sẽ được bỏ qua khi lưu.
        </p>
      </section>

      {state.error && (
        <p className="rounded-xl border border-neon/30 bg-neon/10 px-4 py-3 text-sm text-neon">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-full bg-gold px-7 py-3 text-sm font-bold text-night-950 shadow-lg shadow-gold/20 transition-all hover:brightness-110 disabled:opacity-60"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          {movie ? "Lưu thay đổi" : "Thêm phim"}
        </button>
        <Link
          href="/admin"
          className="rounded-full border border-line px-6 py-3 text-sm font-semibold text-dim transition-colors hover:border-night-600 hover:text-ink"
        >
          Hủy
        </Link>
      </div>
    </form>
  );
}
