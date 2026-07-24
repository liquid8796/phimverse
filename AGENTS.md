<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# PhimVerse — project rules

Vietnamese movie-streaming site (Next.js 16 App Router, Tailwind v4, Auth.js v5,
Drizzle/Neon, Upstash Redis, Vercel Blob, OneDrive streaming). See README.md for
architecture and SETUP.md for infrastructure config.

- **Layering is strict**: pages/components → `server/services` → `server/repositories`
  (interfaces in `repositories/types.ts`). Never query Drizzle directly from pages.
  New data backends implement the repository interfaces; the factory in
  `repositories/index.ts` decides which implementation runs (Postgres vs in-memory demo).
- Demo catalog lives only in `src/data/catalog.ts` — memory repo, `scripts/seed.ts`
  and `scripts/generate-posters.ts` all consume it. Change it in one place.
- Every env var is optional in dev (demo mode). Never make the app crash on missing
  config — degrade gracefully like `server/cache` and `stream.service` do.
- Streaming rule: video bytes must never pass through a serverless function.
  Resolve to a CDN URL (OneDrive downloadUrl, cached in Redis) and let the client
  play it directly.
- UI text is Vietnamese; code identifiers and comments are English.
- Commits follow `type(scope): message` and bump the package version.
- After every patch commit, push to `origin/master` immediately (user rule).
  If the push is rejected, fetch/rebase and report — never force-push.
- After pushing, deploy to Vercel production: `vercel deploy --prod --yes`
  (user rule). Report the deployment URL; if the build fails, fix and redeploy.
- Verify with `npm run lint && npm run typecheck && npm run build` before committing.
