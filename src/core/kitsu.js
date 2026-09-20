/**
 * ============================================================
 *  APIKuoshi — src/core/kitsu.js
 * ============================================================
 *  Kitsu metadata provider (official JSON:API — keyless).
 *
 *  Ported from the AniVault-Scraper design (github.com/SH0MIK/AniVault-Scraper).
 *
 *  Unlike TMDB, Kitsu mirrors MAL's per-season split — Season 2 of an
 *  anime has its own distinct Kitsu anime ID, mapped directly from the
 *  Season 2 MAL ID via /mappings. So there is no season-stripping needed
 *  here; a MAL ID (whichever season) maps straight to the right Kitsu
 *  anime ID, falling back to a plain title search only when that mapping
 *  doesn't exist yet.
 *
 *  Kitsu has NO logo art type (only posterImage/coverImage) and no
 *  per-season art — each Kitsu anime ID has exactly one poster/cover pair.
 * ============================================================
 */
import axios from "axios";
import { cacheGet, cacheSet } from "./cache.js";

const CLIENT = axios.create({
  baseURL: "https://kitsu.app/api/edge",
  timeout: 10000,
  headers: { Accept: "application/vnd.api+json" },
});

/**
 * Resolve a MAL ID (and/or title) to a Kitsu anime ID: MAL mapping first,
 * title search as fallback. Cached under the long-lived mapping bucket
 * since this pairing never changes for a given MAL ID/title.
 */
export async function kitsuAnimeId(malId, animeTitle, log = []) {
  const cacheKey = malId ? `kitsu:id:mal:${malId}` : `kitsu:id:title:${(animeTitle ?? "").toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    log.push("Kitsu ID lookup: cache hit");
    return cached;
  }

  let kitsuId = null;

  if (malId) {
    try {
      const mapRes = await CLIENT.get("/mappings", {
        params: { "filter[externalSite]": "myanimelist/anime", "filter[externalId]": malId, include: "item" },
      });
      for (const item of mapRes.data?.included ?? []) {
        if (item.type === "anime") {
          kitsuId = parseInt(item.id, 10);
          break;
        }
      }
      log.push(`Kitsu mapping: ${kitsuId ? `found ID ${kitsuId}` : "not found"}`);
    } catch (e) {
      log.push(`Kitsu mapping: request failed (${e?.response?.status ?? e?.message})`);
    }
  }

  if (!kitsuId && animeTitle) {
    try {
      const srchRes = await CLIENT.get("/anime", {
        params: { "filter[text]": animeTitle, "page[limit]": 3 },
      });
      const first = srchRes.data?.data?.[0]?.id;
      kitsuId = first ? parseInt(first, 10) : null;
      log.push(`Kitsu title search: ${kitsuId ? `found ID ${kitsuId}` : "not found"}`);
    } catch (e) {
      log.push(`Kitsu title search: request failed (${e?.response?.status ?? e?.message})`);
    }
  }

  cacheSet(cacheKey, kitsuId, 86400);
  return kitsuId;
}

/**
 * Poster + cover (banner) art for a known Kitsu anime ID.
 */
export async function kitsuAnimeImages(kitsuId, isList = false) {
  const log = [];
  const cacheKey = `kitsu:images:${kitsuId}`;
  if (!isList) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      log.push("Kitsu images: cache hit");
      return { result: cached, kitsuAnimeId: kitsuId, log };
    }
  }

  try {
    const animeRes = await CLIENT.get(`/anime/${kitsuId}`);
    const attrs = animeRes.data?.data?.attributes;
    if (!attrs) {
      log.push(`Kitsu anime ${kitsuId}: not found`);
      cacheSet(cacheKey, null, 86400);
      return { result: null, kitsuAnimeId: kitsuId, log };
    }

    const posterImg = attrs.posterImage ?? {};
    const coverImg = attrs.coverImage ?? {};
    const poster = posterImg.large ?? posterImg.medium ?? posterImg.original ?? null;
    const posterOriginal = posterImg.original ?? poster;
    const cover = coverImg.large ?? coverImg.original ?? null;
    const coverOriginal = coverImg.original ?? cover;

    if (!poster && !cover) {
      log.push(`Kitsu anime ${kitsuId}: no poster or cover image available`);
      cacheSet(cacheKey, null, 86400);
      return { result: null, kitsuAnimeId: kitsuId, log };
    }

    const result = {
      kitsuAnimeId: kitsuId,
      canonicalTitle: attrs.canonicalTitle ?? null,
      poster,
      posterOriginal,
      cover,
      coverOriginal,
    };
    cacheSet(cacheKey, result, 86400);
    return { result, kitsuAnimeId: kitsuId, log };
  } catch (e) {
    const status = e?.response?.status;
    log.push(`Kitsu anime ${kitsuId}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, kitsuAnimeId: kitsuId, log };
  }
}

/**
 * BULK episode fetch — ALL episodes for one Kitsu anime ID in a single
 * bounded-parallel walk of the paginated `/anime/{id}/episodes` endpoint.
 *
 * v2.7.1: this replaces the old N+1 path where `kitsuEpisodeData` was
 * called once per episode (≈1 HTTP request per episode). For long-running
 * shows (One Piece, Naruto Shippuden, Conan — 1000+ episodes) the N+1
 * path was the dominant cost on `/api/anime/episodes` and could keep a
 * request open for minutes. The bulk path fetches the whole episode list
 * in `PAGE_SIZE`-sized pages (default 20) with bounded concurrency,
 * turning ~1100 sequential-per-episode HTTP roundtrips into ~55 parallel
 * page fetches (≈20x fewer requests, ≈10x fewer sequential waves).
 *
 * Returns a plain object indexed by episode number:
 *   { [epNum]: { title, titleJapanese, aired, thumbnail, episodeId } }
 * Cached 24h — episode metadata for a finished/releasing anime rarely
 * changes. Never throws — provider failures degrade to {} (the caller
 * falls back to per-episode TMDB / series-poster).
 *
 * The legacy `kitsuEpisodeData` (1-episode lookup) is retained because
 * `/api/chain` still uses it for ONE specific episode; everything that
 * iterates over an episode LIST should use this bulk path.
 */
const KITSU_EP_PAGE_SIZE = 20;
const KITSU_EP_PAGE_CONCURRENCY = 6;

export async function kitsuAllEpisodes(kitsuId) {
  if (!kitsuId) return {};
  const cacheKey = `kitsu:eps-bulk:${kitsuId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const index = {};
  let totalCount = null;

  // First page tells us the total — drives how many parallel walkers we spawn.
  let firstOffset = 0;
  try {
    const r = await CLIENT.get(`/anime/${kitsuId}/episodes`, {
      params: { "page[limit]": KITSU_EP_PAGE_SIZE, "page[offset]": firstOffset },
    });
    totalCount = parseInt(r.data?.meta?.count ?? "0", 10) || 0;
    _absorbKitsuPage(index, r.data?.data ?? []);
  } catch (e) {
    // If the first page fails, no point continuing — return what we have.
    cacheSet(cacheKey, {}, 6 * 3600); // short negative TTL to avoid hammering
    return {};
  }

  if (!totalCount || totalCount <= KITSU_EP_PAGE_SIZE) {
    cacheSet(cacheKey, index, 24 * 3600);
    return index;
  }

  // Spawn bounded-parallel walkers for the remaining pages.
  const offsets = [];
  for (let off = KITSU_EP_PAGE_SIZE; off < totalCount; off += KITSU_EP_PAGE_SIZE) {
    offsets.push(off);
  }

  const runners = Array.from({ length: Math.min(KITSU_EP_PAGE_CONCURRENCY, offsets.length) }, async () => {
    while (offsets.length) {
      const off = offsets.shift();
      if (off == null) return;
      try {
        const r = await CLIENT.get(`/anime/${kitsuId}/episodes`, {
          params: { "page[limit]": KITSU_EP_PAGE_SIZE, "page[offset]": off },
        });
        _absorbKitsuPage(index, r.data?.data ?? []);
      } catch {
        // partial — keep going, the next caller will refill this gap.
      }
    }
  });
  await Promise.all(runners);

  cacheSet(cacheKey, index, 24 * 3600);
  return index;
}

/** Fold one page of Kitsu episode records into the index map. */
function _absorbKitsuPage(index, rows = []) {
  for (const ep of rows) {
    const attrs = ep?.attributes ?? {};
    const n = parseInt(attrs.number, 10);
    if (!Number.isFinite(n)) continue;
    const imgs = attrs.thumbnail ?? {};
    let thumbnail = null;
    for (const size of ["original", "large", "medium", "small", "tiny"]) {
      if (imgs[size]) { thumbnail = imgs[size]; break; }
    }
    const title = attrs.canonicalTitle ?? attrs.titles?.en ?? attrs.titles?.en_us ?? null;
    const titleJapanese = attrs.titles?.ja_jp ?? null;
    const aired = attrs.airdate ?? null;
    // Skip rows that contribute nothing — keeps the index tight.
    if (!title && !thumbnail && !aired && !titleJapanese) continue;
    index[n] = {
      episodeId: parseInt(ep.id, 10) || null,
      title,
      titleJapanese,
      aired,
      thumbnail,
    };
  }
}

/**
 * Episode-specific data (title + thumbnail) for a known Kitsu anime ID +
 * episode number. Thumbnail sizes tried largest-first.
 *
 * NOTE (v2.7.1): for LIST iteration use `kitsuAllEpisodes(kitsuId)` —
 * it fetches the whole series in one bounded-parallel walk instead of
 * one HTTP request per episode. This single-episode lookup is retained
 * for `/api/chain` which only needs ONE episode.
 */
export async function kitsuEpisodeData(kitsuId, epNum, isList = false) {
  const log = [];
  const cacheKey = `kitsu:epdata:${kitsuId}:${epNum}`;
  if (!isList) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      log.push("Kitsu ep data: cache hit");
      return { result: cached, kitsuAnimeId: kitsuId, log };
    }
  }

  try {
    const epRes = await CLIENT.get(`/anime/${kitsuId}/episodes`, {
      params: { "filter[number]": epNum, "page[limit]": 1 },
    });
    const epData = epRes.data?.data?.[0] ?? null;
    if (!epData) {
      log.push(`Kitsu ep ${epNum}: episode record not found`);
      cacheSet(cacheKey, null, 86400);
      return { result: null, kitsuAnimeId: kitsuId, log };
    }

    const attrs = epData.attributes ?? {};
    const title = attrs.canonicalTitle ?? attrs.titles?.en ?? attrs.titles?.en_us ?? null;
    const titleJapanese = attrs.titles?.ja_jp ?? null;
    const aired = attrs.airdate ?? null;
    const imgs = attrs.thumbnail ?? {};
    let thumbnail = null;
    for (const size of ["original", "large", "medium", "small", "tiny"]) {
      if (imgs[size]) {
        thumbnail = imgs[size];
        break;
      }
    }

    if (!title && !thumbnail) {
      log.push(`Kitsu ep ${epNum}: no title or thumbnail on Kitsu`);
      cacheSet(cacheKey, null, 86400);
      return { result: null, kitsuAnimeId: kitsuId, log };
    }

    const result = {
      kitsuAnimeId: kitsuId,
      episodeId: parseInt(epData.id, 10),
      title,
      titleJapanese,
      aired,
      thumbnail,
    };
    cacheSet(cacheKey, result, 86400);
    return { result, kitsuAnimeId: kitsuId, log };
  } catch (e) {
    const status = e?.response?.status;
    log.push(`Kitsu ep ${epNum}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, kitsuAnimeId: kitsuId, log };
  }
}
