# PhimVerse 🎬

A 4K-capable movie streaming site with a Vietnamese UI, design-inspired by PhimFox.
Next.js 16 (App Router) · Vercel Blob · Neon Postgres · Upstash Redis · OneDrive streaming.

> The user-facing interface is in Vietnamese by design. Code, comments and docs are English.

## Quick start (demo mode — no configuration needed)

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no environment variables set, the app boots against an
in-memory catalog of 21 movies playing public sample videos, so nothing has to be
provisioned first. Demo account: `demo@phimverse.dev` / `demo1234` (also the admin
account in demo mode).

To wire up real infrastructure (Vercel storage + OneDrive), see **[SETUP.md](SETUP.md)**.

## Architecture

```text
src/
├── app/                  # Routes (App Router) + API routes
├── components/           # UI components (layout, movies, player, admin, ...)
├── data/catalog.ts       # Single source of demo data (memory repo + seed + posters)
├── lib/                  # Constants and helpers shared by client and server
├── server/
│   ├── db/               # Drizzle schema + Neon client
│   ├── cache/            # Upstash Redis with in-memory fallback, read-through cache
│   ├── onedrive/         # Microsoft Graph client (tokens + downloadUrl)
│   ├── storage/          # Vercel Blob wrapper
│   ├── repositories/     # Repository pattern: interfaces + Drizzle impl + memory impl
│   ├── services/         # Business logic (movie, stream, trending, user, admin)
│   └── actions/          # Server Actions (auth, profile, collection, admin)
└── types/                # Shared domain types
```

**Key design decisions**

- **Repository pattern** — the service layer depends only on the interfaces in
  `repositories/types.ts`; the factory in `repositories/index.ts` picks the Postgres or
  in-memory implementation based on `DATABASE_URL`. Adding a data backend means
  implementing the interfaces, not touching business logic.
- **Service layer** — caching policy, validation and domain rules live in
  `server/services/*`, isolated from both UI and data access.
- **Read-through cache** — the `cached()` helper wraps every hot query in Redis. Cache
  keys embed a catalog version that admin mutations bump, invalidating derived keys at once.
- **Infrastructure adapters** — Blob, OneDrive and Redis are thin, swappable modules that
  degrade gracefully when unconfigured, so the app never crashes on missing env vars.

**Why 4K playback stays smooth**: the player calls `/api/stream/:id?format=json` once to
resolve a CDN URL (the OneDrive `downloadUrl`, which supports HTTP Range and is cached in
Redis for 45 minutes), then plays it directly. Video bytes never pass through a serverless
function — every seek and buffer request goes straight to Microsoft's CDN. If a
pre-signed URL expires mid-playback, the player transparently re-resolves it and resumes
at the same position.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev server / production build / serve |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm run posters` | Generate demo poster + backdrop artwork into `/public` |
| `npm run db:push` | Create Postgres tables from the schema (drizzle-kit) |
| `npm run db:seed` | Seed the catalog + demo account (uploads artwork to Blob when a token is present) |
| `npm run db:studio` | Drizzle Studio — inspect and edit data |
| `npm run encode` | From one source file: encode 1080p/720p/360p with ffmpeg, upload to OneDrive, register in the DB |

Run `npm run lint && npm run typecheck && npm run build` before committing.

## Features

- **Home** — rotating hero spotlight, filter bar (type / genre / country / year / duration /
  sort) and carousels: Featured, Latest Movies, Latest Series, Most Watched, Top Rated.
- **Browse** — dedicated movie, series, trending and search pages; all filters are
  URL-driven, so results are shareable and back-button friendly.
- **Detail page** — synopsis, metadata, episode grid and related titles.
- **Custom player** — quality selector for 4K/1080p/720p/360p (switching keeps the current
  position), seek, volume, playback speed, Picture-in-Picture, fullscreen, keyboard
  shortcuts, HLS via hls.js, and automatic save/resume of watch progress.
- **Live search** — debounced overlay with a full results page; `/` opens it anywhere.
- **My list** — Updates (in-progress titles with a progress bar), Watching, Wishlist, Watched.
- **Account** — change display name, email and password; balance and friend invite codes.
- **Weekly trending** — view counters in Redis sorted sets, so ranking never hits Postgres.
- **Auth** — credentials sign-up/sign-in with stateless JWT sessions (Auth.js v5).
- **Admin area** — separate sign-in at `/admin/login`, authorized via `ADMIN_EMAILS`.
  Create, edit, delete and search movies; manage episodes and their per-resolution
  OneDrive sources; caches invalidate automatically after every change.

## Adding a movie

1. Create the movie in `/admin` (episodes may be saved without sources).
2. Encode and publish each episode from a **single source file** — the pipeline probes the
   resolution, remuxes the original losslessly with `+faststart`, encodes the lower rungs,
   uploads everything to OneDrive and registers the sources:

```bash
npm run encode -- --slug silo --ep 1 --input "D:\movies\silo-e01.mkv"
```

Requires `ffmpeg` on `PATH` and the `Files.ReadWrite.All` Graph permission. Full options
and the manual alternative are documented in [SETUP.md](SETUP.md) (section 4d).

## Deployment

Deployed on Vercel. Production: https://phimverse.vercel.app

```bash
vercel deploy --prod
```

Environment variables are listed in [.env.example](.env.example) and explained in
[SETUP.md](SETUP.md). Every variable is optional in development — the app degrades to demo
mode instead of failing.
