import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load env files the way Next.js does in dev — most specific first wins.
// (`dotenv/config` alone only reads `.env`, missing `vercel env pull`'s `.env.local`.)
config({ path: [".env.development.local", ".env.local", ".env"], quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL chưa được thiết lập. Chạy `vercel env pull .env.local` (sau khi kết nối Neon trong Vercel → Storage) hoặc thêm DATABASE_URL vào .env.local.",
  );
}

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
