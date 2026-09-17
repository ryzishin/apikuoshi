/**
 * ============================================================
 *  APIKuoshi — src/core/enrich.js                     v2.3.0
 * ============================================================
 *  THE ART ENRICHMENT CHAIN — one chain, every surface.
 *
 *  Upstream (scraped source) → Kitsu (keyless) → TMDB (optional,
 *  keyed). Every endpoint that emits anime art routes through
 *  THIS module — nothing talks to the providers directly.
 *
 *  HARD RULES (all enforced here):
 *    1. A provider failure can NEVER turn a 200 into a 5xx.
 *       Every provider call is caught, timed out and treated as
 *       "no data" — the chain just continues.
 *    2. A response is never blocked longer than the providers'
 *       own 10 s timeouts + a safety margin (12 s cap per call).
 *    3. List enrichment runs with BOUNDED concurrency
 *       (ENRICH_CONCURRENCY, default 8) — 50 items are enriched
 *       in parallel waves, never serially.
 *    4. Providers cache internally (24 h, kitsu.js/tmdb.js) —
 *       this layer only adds an in-flight DEDUP so parallel
 *       requests for the same anime share one upstream fetch.
 *    5. When nothing fills poster → poster: null EXPLICITLY and
 *       artSource: null (shape.js art null policy). Gaps are
 *       reported, never hidden and never fabricated.
 *
 *  artSource vocabulary: "upstream" | "kitsu" | "tmdb" | null
 *  (thumbSource adds "poster" = series-poster fallback).
 * ============================================================
 */
import { kitsuAnimeId, kitsuAnimeImages, kitsuEpisodeData } from "./kitsu.js";
import { tmdbAnimeImages, tmdbEpisodeData, tmdbEnabled, extractSeasonHint } from "./tmdb.js";
import { cacheGet, cacheSet } from "./cache.js";

/** Bounded concurrency for list enrichment (8–10 recommended). */
export const ENRICH_CONCURRENCY =
  Math.min(Math.max(parseInt(process.env.ENRICH_CONCURRENCY, 10) || 8, 1), 16);

/** Global kill switch: ART_ENRICHMENT=0 skips every provider call. */
export const enrichmentEnabled = () => process.env.ART_ENRICHMENT !== "0";

/** Safety cap on top of the providers' own 10 s axios timeouts. */
const PROVIDER_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.ENRICH_TIMEOUT_MS, 10) || 12000, 3000), 30000
);

/** Never let a provider call hold a response hostage. */
function guard(promise, label) {
  return Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => resolve(null), PROVIDER_TIMEOUT_MS)),
  ]).catch((err) => {
    console.error(`[APIKUOSHI][enrich] ${label} failed:`, err?.message || err);
    return null;
  });
}

// ------------------------------------------------------- in-flight dedup
const inflight = new Map();

/** Parallel callers for the same key share ONE upstream fetch. */
function dedup(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ------------------------------------------------------- bounded pool
/**
 * Map `worker` over `items` with at most `limit` concurrent tasks.
 * Worker failures never reject — they resolve to null (the worker
 * is expected to handle its own errors; this is the outer net).
 */
export async function mapPool(items, worker, limit = ENRICH_CONCURRENCY) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      try {
        out[i] = await worker(list[i], i);
      } catch (err) {
        console.error("[APIKUOSHI][enrich] worker failed:", err?.message || err);
        out[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

// ------------------------------------------------------- Kitsu
/**
 * Kitsu poster + cover for one anime. malId → Kitsu mapping first
 * (mirrors MAL per-season split), title search as the keyless
 * fallback. Result shape: { poster, cover, kitsuAnimeId } | null.
 * Short-TTL front cache (6 h) + in-flight dedup on top of the
 * providers' own 24 h cache — the front cache prevents a live
 * fetch burst after a cold start, which the task allows.
 */
export async function kitsuArtFor({ malId = null, title = "" } = {}) {
  if (!enrichmentEnabled() || (!malId && !title)) return null;
  const key = `enrich:kitsu:${malId ?? ""}:${String(title).toLowerCase()}`;
  return dedup(key, async () => {
    const front = cacheGet(key);
    if (front !== undefined) return front;
    const kitsuId = await guard(kitsuAnimeId(malId ? parseInt(malId, 10) : null, title || ""), "kitsuAnimeId");
    if (!kitsuId) {
      cacheSet(key, null, 6 * 3600);
      return null;
    }
    const imgs = await guard(kitsuAnimeImages(kitsuId), "kitsuAnimeImages");
    const result = imgs?.result
      ? { poster: imgs.result.poster ?? null, cover: imgs.result.cover ?? null, kitsuAnimeId }
      : null;
    cacheSet(key, result, 6 * 3600);
    return result;
  });
}

// ------------------------------------------------------- TMDB
/**
 * TMDB poster + backdrop + logo for one anime by title.
 * extractSeasonHint() runs FIRST so "Attack on Titan Season 3" /
 * "Youjo Senki II" target the right season poster; the raw title
 * stays as a fallback search candidate when the hinted one misses.
 * Result shape: { poster, backdrop, logo, season } | null.
 * No-op (null, zero noise) when TMDB_API_KEY is unset.
 */
export async function tmdbArtFor({ title = "" } = {}) {
  if (!enrichmentEnabled() || !tmdbEnabled() || !title) return null;
  const key = `enrich:tmdb:${String(title).toLowerCase()}`;
  return dedup(key, async () => {
    const front = cacheGet(key);
    if (front !== undefined) return front;
    const hint = extractSeasonHint(title);
    const attempts = [];
    if (hint.season) attempts.push({ t: hint.base, s: hint.season });
    attempts.push({ t: title, s: null });
    if (hint.season && hint.base !== title) attempts.push({ t: hint.base, s: null });
    for (const { t, s } of attempts) {
      const res = await guard(tmdbAnimeImages(t, s), `tmdbAnimeImages(${t})`);
      if (res?.result) {
        const r = res.result;
        const out = { poster: r.poster ?? null, backdrop: r.backdrop ?? null, logo: r.logo ?? null, season: r.season ?? null };
        cacheSet(key, out, 6 * 3600);
        return out;
      }
    }
    cacheSet(key, null, 6 * 3600);
    return null;
  });
}

// ------------------------------------------------------- anime art chain
/**
 * THE anime art chain for ONE shaped item (canonicalAnime /
 * animeListItem output). Mutates nothing — returns the art fields
 * to merge:
 *   { poster, cover, backdrop, banner, logo, artSource }
 *
 * Order per field:
 *   poster  : upstream → Kitsu → TMDB
 *   cover   : upstream → Kitsu → TMDB backdrop (detail only)
 *   backdrop: TMDB (detail only)
 *   banner  : upstream (AniList) → TMDB backdrop (detail only)
 *   logo    : TMDB only (detail only)
 *
 * List mode (`detail: false`) keeps lists fast: it only hunts
 * what the list contract needs (poster, cover) and only calls
 * TMDB to RESCUE a missing poster. Detail mode runs the full
 * chain for the single item a detail response carries.
 *
 * `art: "0"` (skipArt) short-circuits — documented escape hatch.
 */
export async function enrichAnimeArt(item = {}, { detail = false, skipArt = false } = {}) {
  const art = {
    poster: item.poster ?? null,
    cover: item.cover ?? null,
    backdrop: detail ? (item.backdrop ?? null) : undefined,
    banner: item.banner || "",
    logo: detail ? (item.logo ?? null) : undefined,
    artSource: item.artSource ?? null,
  };
  if (skipArt || !enrichmentEnabled()) {
    if (art.artSource === null && art.poster) art.artSource = "upstream";
    if (art.poster === undefined) delete art.poster;
    if (art.cover === undefined) delete art.cover;
    return art;
  }

  const upstreamPoster = Boolean(item.poster);
  if (upstreamPoster && art.artSource === null) art.artSource = "upstream";

  const needPoster = !art.poster;
  const needCover = !art.cover; // browse contract wants cover on lists too (Kitsu supplies it)
  const needDetailArt = detail && (!art.backdrop || !art.logo);
  const needKitsu = needPoster || needCover;
  const needTmdb = needPoster || needDetailArt || (detail && !art.cover);

  let kitsu = null;
  let tmdb = null;

  if (needKitsu) {
    kitsu = await kitsuArtFor({
      malId: item.malId ?? null,
      title: item.titleRomaji || item.title || item.titleEnglish || "",
    });
  }
  if (kitsu) {
    if (!art.poster && kitsu.poster) {
      art.poster = kitsu.poster;
      art.artSource = "kitsu";
    }
    if (!art.cover && kitsu.cover) art.cover = kitsu.cover;
  }

  if (needTmdb && (!art.poster || detail)) {
    tmdb = await tmdbArtFor({ title: item.titleRomaji || item.title || item.titleEnglish || "" });
  }
  if (tmdb) {
    if (!art.poster && tmdb.poster) {
      art.poster = tmdb.poster;
      art.artSource = "tmdb";
    }
    if (detail) {
      if (!art.cover && tmdb.backdrop) art.cover = tmdb.backdrop;
      if (!art.backdrop && tmdb.backdrop) art.backdrop = tmdb.backdrop;
      if (!art.logo && tmdb.logo) art.logo = tmdb.logo;
    } else if (!art.poster && tmdb.backdrop && !art.cover) {
      // last-resort list art: a backdrop is better than a blank tile
      art.cover = tmdb.backdrop;
    }
  }

  // banner: AniList banner wins; TMDB backdrop fills on detail
  if (detail && !art.banner && tmdb?.backdrop) art.banner = tmdb.backdrop;

  // explicit-null policy: nothing anywhere → null, never ""
  if (!art.poster) { art.poster = null; art.artSource = null; }
  if (art.cover === "") art.cover = null;
  if (detail) {
    if (art.backdrop === "") art.backdrop = null;
    if (art.logo === "") art.logo = null;
  } else {
    delete art.backdrop;
    delete art.logo;
  }
  return art;
}

/**
 * Enrich a list of shaped items IN PLACE with bounded concurrency.
 * Returns a small coverage report for the test surface:
 *   { upstream, kitsu, tmdb, none, total }
 */
export async function enrichItemList(items, { detail = false, skipArt = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const coverage = { upstream: 0, kitsu: 0, tmdb: 0, none: 0, total: list.length };
  if (skipArt || !enrichmentEnabled() || !list.length) {
    for (const it of list) {
      if (it && it.poster && it.artSource === null) it.artSource = "upstream";
      else if (it && !it.poster) it.artSource = null;
    }
    coverage.upstream = list.filter((i) => i?.poster).length;
    coverage.none = list.length - coverage.upstream;
    return coverage;
  }
  await mapPool(list, async (item) => {
    if (!item || typeof item !== "object") return;
    const art = await enrichAnimeArt(item, { detail });
    if (art.poster === undefined) delete art.poster;
    else item.poster = art.poster;
    if (art.cover === undefined) delete art.cover;
    else item.cover = art.cover;
    if (detail) {
      if (art.banner !== undefined) item.banner = art.banner;
      if (art.backdrop !== undefined) item.backdrop = art.backdrop;
      if (art.logo !== undefined) item.logo = art.logo;
    }
    item.artSource = art.artSource;
    if (art.artSource === "upstream") coverage.upstream++;
    else if (art.artSource === "kitsu") coverage.kitsu++;
    else if (art.artSource === "tmdb") coverage.tmdb++;
    else coverage.none++;
  });
  return coverage;
}

// ------------------------------------------------------- episode thumb chain
/**
 * THE episode-thumbnail chain for ONE episode:
 *   upstream thumb → Kitsu kitsuEpisodeData(kitsuId, epNum) →
 *   TMDB tmdbEpisodeData(title, epNum, seasonHint, false,
 *   expectedAired) → series-poster fallback → null.
 *
 * `expectedAired` (from the MAL index) feeds TMDB's sanity check
 * so split-cour shows can't grab the wrong episode's still.
 * Returns { thumbnail, thumbSource, title?, aired? } — caller
 * merges onto the episode record.
 */
export async function enrichEpisodeThumb({
  number = null,
  upstreamThumb = "",
  kitsuId = null,
  seriesTitle = "",
  seasonHint = null,
  expectedAired = null,
  seriesPoster = "",
} = {}) {
  if (upstreamThumb) return { thumbnail: upstreamThumb, thumbSource: "upstream" };
  if (!enrichmentEnabled() || !number) {
    return seriesPoster
      ? { thumbnail: seriesPoster, thumbSource: "poster" }
      : { thumbnail: null, thumbSource: null };
  }

  // 1. Kitsu — keyless, mirrors MAL per-season split
  if (kitsuId) {
    const kit = await guard(kitsuEpisodeData(kitsuId, number), `kitsuEpisodeData(${number})`);
    if (kit?.result?.thumbnail || kit?.result?.aired) {
      return {
        thumbnail: kit.result.thumbnail ?? null,
        title: kit.result.title ?? undefined,
        aired: kit.result.aired ?? undefined,
        thumbSource: kit.result.thumbnail ? "kitsu" : null,
      };
    }
  }

  // 2. TMDB — optional, keyed; expectedAired guards wrong matches
  if (tmdbEnabled() && seriesTitle) {
    const tmdb = await guard(
      tmdbEpisodeData(seriesTitle, number, seasonHint, false, expectedAired),
      `tmdbEpisodeData(${number})`
    );
    if (tmdb?.result?.thumbnail || tmdb?.result?.aired) {
      return {
        thumbnail: tmdb.result.thumbnail ?? null,
        title: tmdb.result.title ?? undefined,
        aired: tmdb.result.aired ?? undefined,
        thumbSource: tmdb.result.thumbnail ? "tmdb" : null,
      };
    }
  }

  // 3. series-poster fallback → 4. explicit null
  return seriesPoster
    ? { thumbnail: seriesPoster, thumbSource: "poster" }
    : { thumbnail: null, thumbSource: null };
}

/** Resolve the Kitsu id once per anime (malId mapping → title search). */
export async function resolveKitsuId({ malId = null, title = "" } = {}) {
  if (!enrichmentEnabled() || (!malId && !title)) return null;
  return kitsuArtFor({ malId, title }).then((r) => r?.kitsuAnimeId ?? null).catch(() => null);
}

export { extractSeasonHint, tmdbEnabled };
