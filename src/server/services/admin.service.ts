import { GENRES, COUNTRIES, isResolution, resolutionLabel } from "@/lib/constants";
import { slugify } from "@/lib/utils";
import { getRepositories } from "@/server/repositories";
import type {
  AdminEpisodeInput,
  AdminMovieDetail,
  AdminMovieInput,
  AdminSourceInput,
} from "@/server/repositories/types";
import { bumpCatalogVersion } from "./movie.service";
import type { Movie } from "@/types";

/** Admin catalog management — validation + persistence + cache invalidation. */

export class AdminServiceError extends Error {}

const QUALITIES = new Set(["4K", "FHD", "HD", "CAM"]);
const GENRE_SLUGS = new Set(GENRES.map((g) => g.slug));

export async function listMoviesForAdmin(query: string): Promise<Movie[]> {
  const repo = getRepositories().movies;
  if (query.trim()) return repo.search(query, 100);
  const result = await repo.list({ sort: "updated", pageSize: 100 });
  return result.items;
}

export async function getMovieForAdmin(id: string): Promise<AdminMovieDetail | null> {
  return getRepositories().movies.adminDetail(id);
}

function validate(input: AdminMovieInput): AdminMovieInput {
  if (input.title.trim().length < 1) throw new AdminServiceError("Tên phim không được để trống.");
  if (!input.slug) input.slug = slugify(input.title);
  if (!/^[a-z0-9-]+$/.test(input.slug)) {
    throw new AdminServiceError("Slug chỉ được chứa chữ thường, số và dấu gạch ngang.");
  }
  if (input.type !== "single" && input.type !== "series") {
    throw new AdminServiceError("Loại phim không hợp lệ.");
  }
  if (!Number.isFinite(input.year) || input.year < 1900 || input.year > 2100) {
    throw new AdminServiceError("Năm sản xuất không hợp lệ.");
  }
  if (!(input.country in COUNTRIES)) throw new AdminServiceError("Quốc gia không hợp lệ.");
  if (!QUALITIES.has(input.quality)) throw new AdminServiceError("Chất lượng không hợp lệ.");
  if (!Number.isFinite(input.rating) || input.rating < 0 || input.rating > 10) {
    throw new AdminServiceError("Điểm đánh giá phải nằm trong khoảng 0–10.");
  }
  input.genres = input.genres.filter((g) => GENRE_SLUGS.has(g));
  if (input.genres.length === 0) throw new AdminServiceError("Chọn ít nhất một thể loại.");

  if (input.episodes.length === 0) {
    throw new AdminServiceError("Phim cần ít nhất một tập.");
  }
  const seen = new Set<string>();
  input.episodes = input.episodes.map((ep, index): AdminEpisodeInput => {
    const number = Number.isFinite(ep.number) && ep.number > 0 ? ep.number : index + 1;
    const key = `${ep.season}:${number}`;
    if (seen.has(key)) throw new AdminServiceError(`Tập ${number} bị trùng số tập.`);
    seen.add(key);

    // Rows with neither a OneDrive path nor a URL are simply dropped: an
    // episode may be saved source-less and filled later by `npm run encode`.
    const filledSources = (ep.sources ?? []).filter(
      (source) => source.oneDrivePath?.trim() || source.fallbackUrl?.trim(),
    );
    const seenResolutions = new Set<string>();
    const sources = filledSources.map((source): AdminSourceInput => {
      if (!isResolution(source.resolution)) {
        throw new AdminServiceError(`Tập ${number}: độ phân giải không hợp lệ.`);
      }
      if (seenResolutions.has(source.resolution)) {
        throw new AdminServiceError(
          `Tập ${number}: độ phân giải ${resolutionLabel(source.resolution)} bị trùng.`,
        );
      }
      seenResolutions.add(source.resolution);
      return {
        resolution: source.resolution,
        sourceType: source.sourceType === "hls" ? "hls" : "mp4",
        oneDrivePath: source.oneDrivePath?.trim() || null,
        fallbackUrl: source.fallbackUrl?.trim() || null,
      };
    });

    return {
      season: Number.isFinite(ep.season) && ep.season > 0 ? ep.season : 1,
      number,
      title: ep.title.trim() || (input.type === "series" ? `Tập ${number}` : "Bản Full"),
      duration: Number.isFinite(ep.duration) && ep.duration > 0 ? ep.duration : input.duration,
      sources,
    };
  });

  // Default artwork so cards never render a broken image.
  if (!input.posterUrl.trim()) input.posterUrl = "/posters/_placeholder.jpg";
  if (!input.backdropUrl.trim()) input.backdropUrl = "/backdrops/_placeholder.jpg";
  return input;
}

export async function saveMovie(
  id: string | null,
  raw: AdminMovieInput,
): Promise<{ id: string; slug: string }> {
  const repo = getRepositories().movies;
  const input = validate(raw);

  const existing = await repo.bySlug(input.slug);
  if (existing && existing.id !== id) {
    throw new AdminServiceError(`Slug "${input.slug}" đã được dùng bởi phim khác.`);
  }

  let movieId: string;
  if (id) {
    if (!(await repo.byId(id))) throw new AdminServiceError("Không tìm thấy phim cần sửa.");
    await repo.update(id, input);
    movieId = id;
  } else {
    movieId = (await repo.create(input)).id;
  }
  await bumpCatalogVersion();
  return { id: movieId, slug: input.slug };
}

export async function deleteMovie(id: string): Promise<void> {
  const repo = getRepositories().movies;
  if (!(await repo.byId(id))) throw new AdminServiceError("Không tìm thấy phim cần xóa.");
  await repo.remove(id);
  await bumpCatalogVersion();
}
