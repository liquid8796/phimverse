# PhimVerse 🎬

Website xem phim trực tuyến chất lượng 4K, lấy cảm hứng thiết kế từ PhimFox.
Next.js 16 (App Router) · Vercel Blob · Neon Postgres · Upstash Redis · streaming từ OneDrive.

## Chạy thử ngay (demo mode — không cần cấu hình)

```bash
npm install
npm run dev
```

Mở http://localhost:3000 — app tự chạy với catalog 21 phim trong bộ nhớ và video mẫu.
Tài khoản demo: `demo@phimverse.dev` / `demo1234`.

Cấu hình hạ tầng thật (Vercel + OneDrive): xem **[SETUP.md](SETUP.md)**.

## Kiến trúc

```text
src/
├── app/                  # Routes (App Router) + API routes
├── components/           # UI components (layout, movies, player, ...)
├── data/catalog.ts       # Nguồn dữ liệu demo duy nhất (memory repo + seed + posters)
├── lib/                  # Hằng số, helpers dùng chung client/server
├── server/
│   ├── db/               # Drizzle schema + Neon client
│   ├── cache/            # Redis (Upstash) + fallback in-memory, read-through cache
│   ├── onedrive/         # Microsoft Graph client (token + downloadUrl)
│   ├── storage/          # Vercel Blob wrapper
│   ├── repositories/     # Repository pattern: interface + Drizzle impl + Memory impl
│   ├── services/         # Business logic (movie, stream, trending, user)
│   └── actions/          # Server Actions (auth, profile, collection)
└── types/                # Domain types dùng chung
```

**Design patterns chính**

- **Repository pattern** — service layer chỉ phụ thuộc interface trong
  `repositories/types.ts`; factory tự chọn Postgres hay in-memory theo env.
  Thêm backend mới = implement interface, không sửa business logic.
- **Service layer** — caching policy, validation, nghiệp vụ nằm ở
  `server/services/*`, tách khỏi cả UI lẫn data access.
- **Read-through cache** — helper `cached()` bọc mọi truy vấn nóng bằng Redis.
- **Adapter cho hạ tầng** — Blob/OneDrive/Redis đều là module mỏng, dễ thay thế.

**Vì sao 4K mượt**: player gọi `/api/stream/:id?format=json` một lần để lấy URL
CDN (OneDrive `downloadUrl`, hỗ trợ HTTP Range, cache 45' trong Redis) rồi phát
trực tiếp — byte video không bao giờ đi qua serverless function. URL hết hạn
giữa chừng sẽ được player tự resolve lại và tua về đúng vị trí.

## Scripts

| Lệnh | Chức năng |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` / `typecheck` | ESLint / tsc |
| `npm run posters` | Sinh poster + backdrop demo vào `/public` |
| `npm run db:push` | Tạo bảng Postgres từ schema (drizzle-kit) |
| `npm run db:seed` | Seed catalog + tài khoản demo (tự upload ảnh lên Blob nếu có token) |
| `npm run db:studio` | Drizzle Studio — xem/sửa dữ liệu |
| `npm run encode` | Từ 1 file gốc: tự encode 1080p/720p/360p (ffmpeg), upload OneDrive, ghi DB |

## Tính năng

- Trang chủ: hero banner xoay vòng, bộ lọc (loại/thể loại/quốc gia/năm/thời lượng/sắp xếp), carousel Phim Đề Cử / Phim Lẻ Mới / Phim Bộ Mới / Xem Nhiều / Đánh Giá Cao
- Trang chi tiết + danh sách tập, phim liên quan
- Player tùy biến: chọn chất lượng 4K/1080p/720p/360p (giữ nguyên vị trí đang xem khi
  đổi), tua nhanh, âm lượng, tốc độ phát, PiP, fullscreen, phím tắt, HLS (hls.js),
  tự lưu & khôi phục tiến độ xem
- Tìm kiếm live (debounce) + trang kết quả
- Danh sách của tôi: Cập Nhật (đang xem dở kèm progress) / Đang Xem / Mong Muốn / Đã Xem
- Tài khoản: đổi tên/email/mật khẩu, số dư, mã mời bạn bè
- Trending theo tuần (Redis sorted set), đăng ký/đăng nhập (Auth.js v5)
- Khu vực quản trị `/admin` (đăng nhập riêng tại `/admin/login`, quyền theo
  `ADMIN_EMAILS`): thêm/sửa/xóa/tìm kiếm phim, quản lý tập + nguồn OneDrive,
  tự vô hiệu cache sau mỗi thay đổi
