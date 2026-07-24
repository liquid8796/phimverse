# Hướng dẫn cấu hình PhimVerse

Website chạy được **ngay lập tức ở chế độ demo** (không cần biến môi trường nào):
dữ liệu phim nằm trong bộ nhớ, video phát từ nguồn mẫu công khai.
Tài khoản demo: `demo@phimverse.dev` / `demo1234`.

Làm theo các bước dưới đây để chuyển sang hạ tầng thật trên Vercel.

---

## 0. Deploy lên Vercel

```bash
npm i -g vercel
vercel login
vercel link        # tạo/liên kết project
vercel deploy      # preview
vercel deploy --prod
```

Hoặc push repo lên GitHub rồi **Import** tại https://vercel.com/new (mỗi lần push sẽ tự deploy).

Sau khi có project, đặt biến bắt buộc cho production:

```bash
# Tạo secret: openssl rand -base64 32
vercel env add AUTH_SECRET production
```

---

## 1. Database quan hệ — Neon Postgres (Vercel Marketplace)

Lưu: users, movies, episodes, genres, collections (danh sách của tôi), watch_progress (tiến độ xem).

1. Vercel Dashboard → project → tab **Storage** → **Create Database** → chọn **Neon** (Serverless Postgres) → region gần người dùng (Singapore cho VN).
2. Vercel tự inject `DATABASE_URL` vào project.
3. Kéo env về local, tạo bảng và seed dữ liệu:

```bash
vercel env pull .env.local
npm run db:push     # tạo bảng từ src/server/db/schema.ts
npm run db:seed     # nạp 21 phim demo + tài khoản demo
```

> `npm run db:studio` mở Drizzle Studio để xem/sửa dữ liệu trực tiếp.

Khi `DATABASE_URL` tồn tại, repository factory (`src/server/repositories/index.ts`) tự chuyển từ in-memory sang Postgres — không cần đổi code.

## 2. NoSQL — Upstash Redis (Vercel Marketplace)

Dùng cho: cache trang chủ/chi tiết phim, cache URL stream OneDrive (quan trọng cho tốc độ 4K), cache token Microsoft Graph, bộ đếm view trending (sorted set theo tuần).

1. Tab **Storage** → **Create Database** → chọn **Upstash** (Serverless Redis) → cùng region với Neon.
2. Vercel tự inject `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (bản cũ inject `KV_REST_API_URL`/`KV_REST_API_TOKEN` — code hỗ trợ cả hai).
3. `vercel env pull .env.local` để dùng local.

Không có Redis, app vẫn chạy với cache in-memory (per-instance) — chỉ nên dùng khi dev.

## 3. Vercel Blob — lưu poster/backdrop

1. Tab **Storage** → **Create Database** → **Blob** → đặt tên store.
2. Vercel inject `BLOB_READ_WRITE_TOKEN`.
3. Chạy lại seed để upload toàn bộ poster/backdrop trong `/public` lên Blob CDN:

```bash
vercel env pull .env.local
npm run db:seed
```

Seed sẽ tự phát hiện token, upload ảnh lên Blob và lưu URL CDN vào DB.
Upload thủ công qua API: `POST /api/upload` (multipart: `file`, `kind=posters|backdrops`, `name=<slug>`) — chỉ email trong `ADMIN_EMAILS` được phép.

## 4. OneDrive — stream phim qua Microsoft Graph

File phim nằm trên OneDrive của bạn. App resolve file → lấy `@microsoft.graph.downloadUrl` (URL CDN của Microsoft, hỗ trợ HTTP Range, hạn ~1 giờ) → cache 45 phút trong Redis → player phát **trực tiếp từ CDN Microsoft**, byte video không đi qua server → 4K mượt.

### 4a. Đăng ký Azure App

1. https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `PhimVerse`; Supported account types:
   - OneDrive **cá nhân**: chọn "Personal Microsoft accounts" (hoặc "Accounts in any organizational directory and personal Microsoft accounts").
   - OneDrive **Business**: chọn "Accounts in this organizational directory only".
3. Redirect URI (Web): `http://localhost:5555/callback` (chỉ dùng 1 lần để lấy refresh token).
4. Lưu **Application (client) ID** → `MS_CLIENT_ID`.
5. **Certificates & secrets** → New client secret → lưu **Value** → `MS_CLIENT_SECRET`.

### 4b. Chế độ A — OneDrive cá nhân (refresh token)

1. **API permissions** → Add → Microsoft Graph → **Delegated** → `Files.Read.All`, `offline_access`.
2. Mở URL sau trên trình duyệt (thay CLIENT_ID):

```text
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=http://localhost:5555/callback&scope=Files.Read.All%20offline_access
```

3. Đăng nhập tài khoản Microsoft chứa phim → sau khi redirect, copy tham số `code=...` trên thanh địa chỉ.
4. Đổi code lấy refresh token:

```bash
curl -X POST https://login.microsoftonline.com/consumers/oauth2/v2.0/token -d "client_id=CLIENT_ID&client_secret=CLIENT_SECRET&grant_type=authorization_code&code=CODE&redirect_uri=http://localhost:5555/callback&scope=Files.Read.All offline_access"
```

5. Lưu `refresh_token` trong response → `MS_REFRESH_TOKEN`.

Env cần đặt: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REFRESH_TOKEN`.

### 4c. Chế độ B — OneDrive for Business (app-only)

1. **API permissions** → Add → Microsoft Graph → **Application** → `Files.Read.All` → bấm **Grant admin consent**.
2. Lấy **Directory (tenant) ID** → `MS_TENANT_ID`.
3. Lấy access token tạm (hạn ~1 giờ, chỉ cần cho bước 4 — khi chạy thật app tự xin
   token bằng đúng flow này, xem `src/server/onedrive/client.ts`):

```powershell
# PowerShell — thay MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET của bạn
$token = (Invoke-RestMethod -Method POST `
  -Uri "https://login.microsoftonline.com/MS_TENANT_ID/oauth2/v2.0/token" `
  -Body @{ client_id = "MS_CLIENT_ID"; client_secret = "MS_CLIENT_SECRET";
           grant_type = "client_credentials"; scope = "https://graph.microsoft.com/.default" }
).access_token
```

```bash
# hoặc bash/curl
curl -X POST "https://login.microsoftonline.com/MS_TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=MS_CLIENT_ID&client_secret=MS_CLIENT_SECRET&grant_type=client_credentials&scope=https://graph.microsoft.com/.default"
# → copy trường "access_token" trong JSON trả về
```

4. Lấy drive id → `ONEDRIVE_DRIVE_ID`:

```powershell
(Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/users/EMAIL_CUA_BAN/drive?select=id" `
  -Headers @{ Authorization = "Bearer $token" }).id
```

Env cần đặt: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `ONEDRIVE_DRIVE_ID`.

### 4d. Gắn file phim vào episode (đa độ phân giải)

Mỗi tập phim có thể có nhiều biến thể độ phân giải (4K / 1080p / 720p / 360p) — người xem
chọn chất lượng ngay trong trình phát. Upload từng bản encode lên OneDrive, ví dụ:

```text
Movies/silo/2160p/e01.mp4
Movies/silo/1080p/e01.mp4
Movies/silo/720p/e01.mp4
```

Cách gắn dễ nhất: vào **trang quản trị** (`/admin` → Sửa phim) — mỗi tập có danh sách
độ phân giải, điền `OneDrive path` cho từng bản. Hoặc sửa trực tiếp bảng
`episode_sources` (`npm run db:studio`): mỗi dòng = 1 độ phân giải của 1 tập với
`resolution`, `onedrive_path`, `fallback_url`. Có `onedrive_path` là app tự ưu tiên
OneDrive; nếu lỗi sẽ fallback về `fallback_url`, và nếu thiếu độ phân giải được yêu cầu
thì tự phát bản tốt nhất còn lại.

> **Khuyến nghị 4K**: dùng MP4 (H.264/H.265) có **moov atom ở đầu file** (faststart) để tua nhanh không phải tải đuôi file. Encode: `ffmpeg -i in.mkv -c copy -movflags +faststart out.mp4`.

### Đặt env trên Vercel

```bash
vercel env add MS_CLIENT_ID production
vercel env add MS_CLIENT_SECRET production
vercel env add MS_REFRESH_TOKEN production
# (hoặc MS_TENANT_ID + ONEDRIVE_DRIVE_ID với chế độ B)
vercel env add STREAM_REQUIRE_AUTH production   # nên đặt = 1
```

## 5. Biến môi trường — tổng hợp

| Biến | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `AUTH_SECRET` | Production | `openssl rand -base64 32` |
| `DATABASE_URL` | Khi dùng DB thật | Neon inject tự động |
| `UPSTASH_REDIS_REST_URL/TOKEN` | Nên có | Upstash inject tự động |
| `BLOB_READ_WRITE_TOKEN` | Khi dùng Blob | Blob store inject tự động |
| `MS_CLIENT_ID/SECRET/REFRESH_TOKEN` | Khi stream OneDrive cá nhân | Chế độ A |
| `MS_TENANT_ID`, `ONEDRIVE_DRIVE_ID` | Khi stream OneDrive Business | Chế độ B |
| `STREAM_REQUIRE_AUTH` | Nên = `1` ở production | Chặn hotlink stream |
| `ADMIN_EMAILS` | Cho khu vực quản trị | Danh sách email admin, phân cách bằng dấu phẩy |

## 6. Khu vực quản trị (/admin)

- Đăng nhập quản trị tại **`/admin/login`** (hoặc menu avatar → **Quản trị** khi đã là admin).
- Quyền admin xác định bằng biến `ADMIN_EMAILS` (ví dụ: `ADMIN_EMAILS=ban@email.com,vo@email.com`).
  Tài khoản phải tồn tại (đăng ký như người dùng thường) — `ADMIN_EMAILS` chỉ cấp quyền.
- **Chế độ demo** (chưa có `DATABASE_URL` và chưa đặt `ADMIN_EMAILS`): tài khoản
  `demo@phimverse.dev` / `demo1234` tự động là admin để bạn thử ngay.
- Chức năng: tìm kiếm phim, **Thêm phim** (`/admin/movies/new`), **Sửa** (bút chì),
  **Xóa** (thùng rác, có xác nhận). Form hỗ trợ: slug tự sinh từ tên tiếng Việt,
  thể loại, poster/backdrop URL, danh sách tập với OneDrive path + URL dự phòng
  cho từng tập. Lưu xong cache tự vô hiệu — trang chủ cập nhật ngay.
