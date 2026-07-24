/**
 * Seeds Neon Postgres with the demo catalog (idempotent — safe to re-run).
 *
 *  - Requires DATABASE_URL (run `npm run db:push` first to create tables).
 *  - If BLOB_READ_WRITE_TOKEN is set, posters/backdrops from /public are
 *    uploaded to Vercel Blob and movies reference the Blob CDN URLs.
 *  - Creates a demo account: demo@phimverse.dev / demo1234
 *
 * Run: npm run db:seed
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { put } from "@vercel/blob";
import { CATALOG } from "../src/data/catalog";
import { GENRES } from "../src/lib/constants";
import * as schema from "../src/server/db/schema";

// Load env files the way Next.js does in dev — most specific first wins.
config({ path: [".env.development.local", ".env.local", ".env"], quiet: true });

async function maybeUploadToBlob(kind: "posters" | "backdrops", slug: string): Promise<string> {
  const localPath = `/${kind}/${slug}.jpg`;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return localPath;

  const file = path.join(process.cwd(), "public", kind, `${slug}.jpg`);
  try {
    const body = readFileSync(file);
    const blob = await put(`${kind}/${slug}.jpg`, body, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return blob.url;
  } catch (err) {
    console.warn(`  ! Blob upload failed for ${kind}/${slug}, using local file.`, err);
    return localPath;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Add it to .env.local / .env first.");
    process.exit(1);
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  console.log("Seeding genres...");
  for (const genre of GENRES) {
    await db.insert(schema.genres).values(genre).onConflictDoNothing();
  }

  console.log(`Seeding ${CATALOG.length} movies...`);
  for (const entry of CATALOG) {
    const posterUrl = await maybeUploadToBlob("posters", entry.slug);
    const backdropUrl = await maybeUploadToBlob("backdrops", entry.slug);

    const values = {
      slug: entry.slug,
      title: entry.title,
      originalTitle: entry.originalTitle,
      description: entry.description,
      type: entry.type,
      posterUrl,
      backdropUrl,
      year: entry.year,
      duration: entry.duration,
      country: entry.country,
      quality: entry.quality,
      rating: entry.rating,
      views: entry.views,
      featured: entry.featured,
      updatedAt: new Date(),
    };

    const existing = await db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(eq(schema.movies.slug, entry.slug))
      .limit(1);

    let movieId: string;
    if (existing.length > 0) {
      movieId = existing[0].id;
      await db.update(schema.movies).set(values).where(eq(schema.movies.id, movieId));
    } else {
      const inserted = await db.insert(schema.movies).values(values).returning({
        id: schema.movies.id,
      });
      movieId = inserted[0].id;
    }

    // Genres (reset + relink)
    await db.delete(schema.movieGenres).where(eq(schema.movieGenres.movieId, movieId));
    for (const genreSlug of entry.genres) {
      await db.insert(schema.movieGenres).values({ movieId, genreSlug }).onConflictDoNothing();
    }

    // Episodes + per-resolution sources (reset + insert keeps numbering consistent)
    await db.delete(schema.episodes).where(eq(schema.episodes.movieId, movieId));
    for (const ep of entry.episodes) {
      const inserted = await db
        .insert(schema.episodes)
        .values({
          movieId,
          season: ep.season,
          number: ep.number,
          title: ep.title,
          duration: ep.duration,
        })
        .returning({ id: schema.episodes.id });
      for (const source of ep.sources) {
        await db.insert(schema.episodeSources).values({
          episodeId: inserted[0].id,
          resolution: source.resolution,
          sourceType: source.sourceType,
          oneDrivePath: source.oneDrivePath ?? null,
          fallbackUrl: source.fallbackUrl ?? null,
        });
      }
    }
    console.log(`  ✓ ${entry.title}`);
  }

  console.log("Seeding demo account (demo@phimverse.dev / demo1234)...");
  const demoEmail = "demo@phimverse.dev";
  const existingUser = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, demoEmail))
    .limit(1);
  if (existingUser.length === 0) {
    await db.insert(schema.users).values({
      name: "Nam Trần",
      email: demoEmail,
      passwordHash: bcrypt.hashSync("demo1234", 10),
      balance: 17500,
      createdAt: new Date("2021-12-24"),
    });
  }

  console.log("\nSeed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
