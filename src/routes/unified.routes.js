/**
 * ============================================================
 *  APIKuoshi — src/routes/unified.routes.js          v2.3.0
 * ============================================================
 *  THE API SURFACE. One shape, one schema, one identity.
 *
 *  Families:
 *    CORE     /search /suggestions /resolve
 *    ANIME    /anime /anime/episodes /anime/servers
 *    PLAYBACK /watch /download /chain
 *    BROWSE   /home /spotlight /trending /trending-sidebar /top-ten
 *             /top-rankings /popular /random /upcoming /completed
 *             /new-release /newly-added /latest-updated
 *             /recently-updated /schedule /airing
 *    CATALOG  /az-list/:letter /filter /genre/:genre /type/:type
 *             /status/:status /seasons/:slug /watch-order/:slug
 *    META     /meta /meta/characters /meta/recommendations
 *             /meta/season /meta/mal /meta/external /meta/trending
 *    INFRA    /proxy/hls /proxy/video /proxy/subtitle
 *
 *  Every list-shaped response is normalized to:
 *    { success, api, kind?, count, results: [...] }
 *  Every anime-shaped object is built by core/shape.js:
 *    key slug anilistId malId title titleRomaji titleEnglish
 *    titleNative synonyms poster cover type season year episodes
 *    status score rating genres artSource
 *  ...and then run through the ONE art-enrichment chain
 *  (core/enrich.js): upstream → Kitsu → TMDB, with strict
 *  fallbacks — a provider failure never breaks a response.
 *  Every anime is addressable by ANY of:
 *    ?key=anilist:<id> | mal:<id> | <id> | <slug> | <title>
 * ============================================================
 */
import { Router as expressRouter } from "express";
import axios from "axios";
import { withFallback, unifiedSearch } from "../core/fallback.js";
import {
  anilistById, anilistDetail,
  anilistCharacters, anilistRecommendations, anilistSeason,
  anilistRelations,
} from "../core/anilist.js";
import { getLane } from "../core/registry.js";
import { runStreamingChain, malEpisodeIndex } from "../core/chain.js";
import { canonicalFor, matchSlug } from "../core/keys.js";
import { CustomError } from "../core/errors.js";
import { withCache } from "../core/cache.js";
import { withCdnToken } from "../sources/kaze/helper/cdn.helper.js";
import config from "../config.js";
import {
  canonicalAnime, animeListItem, episodeRecord, relationsBlock,
  keyForIds, cleanListingSlug, titleSlug, normalizeStatus, normalizeType,
} from "../core/shape.js";
import {
  enrichAnimeArt, enrichItemList, enrichEpisodeThumb,
  resolveKitsuId, extractSeasonHint, enrichmentEnabled, tmdbEnabled, mapPool,
} from "../core/enrich.js";

const router = expressRouter();

// ---------------------------------------------------------------- helpers

const wrap = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    next(err);
  }
};

const page = (req) => parseInt(req.query.page, 10) || 1;
const keyOf = (req) => req.query.key || req.query.id;

/** Referer some stream CDNs expect — they 403 without it. */
const STREAM_REFERER = process.env.STREAM_PROXY_REFERER || "https://megaplay.buzz/";

const isHlsUrl = (url = "") => String(url).toLowerCase().includes(".m3u8");

/** Build a same-origin playback URL through the built-in CORS proxies. */
function proxiedUrl(url, referer = null) {
  if (!url) return null;
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : "";
  const enc = encodeURIComponent(url);
  return isHlsUrl(url) ? `/api/proxy/hls?url=${enc}${ref}` : `/api/proxy/video?url=${enc}${ref}`;
}

/** Strip internal bookkeeping fields from any public item (recursive).
 *  Also removes upstream page-tracing URLs — clients never need the
 *  internal fetcher's own page links, and responses stay origin-neutral. */
const INTERNAL_FIELDS = ["lane", "listingId", "source", "sourceId", "subSource", "channel", "raw", "kind"];
const SITE_HOST_RE = /^https?:\/\/[^/]*anikoto/i;

function cleanValue(v) {
  if (Array.isArray(v)) return v.map(cleanValue).filter((x) => x !== undefined);
  if (v && typeof v === "object") return stripInternal(v);
  return v;
}

function stripInternal(item) {
  if (!item || typeof item !== "object") return item;
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (INTERNAL_FIELDS.includes(k)) continue;
    if (typeof v === "string" && SITE_HOST_RE.test(v)) continue;
    out[k] = cleanValue(v);
  }
  return out;
}

/** Normalize one playable stream for the public surface. */
function publicStream(s, referer = null) {
  if (!s?.url && !s?.embedUrl) return null;
  const url = s.url || null;
  const kind = url && (isHlsUrl(url) || /\.(mp4|mkv|webm)(\?|$)/i.test(url)) ? "direct" : (url ? "direct" : "embed");
  const out = {
    provider: s.provider || "server",
    originalName: s.originalName || null,
    type: s.type || null,
    url,
    embedUrl: s.embedUrl || null,
    proxiedUrl: url ? proxiedUrl(url, s.referer || referer) : null,
    isHls: Boolean(s.isHls) || isHlsUrl(url || ""),
    kind: url ? kind : "embed",
  };
  if (s.qualities?.length) out.qualities = s.qualities;
  if (s.subtitles?.length) out.subtitles = s.subtitles;
  if (s.skipIntro) out.skipIntro = s.skipIntro;
  return out;
}

/** Public anime RESOURCE — built exclusively by core/shape.js. */
function publicAnime(canonicalEntry, extra = {}) {
  if (!canonicalEntry || typeof canonicalEntry !== "object") return { ...extra };
  return canonicalAnime({ canonical: canonicalEntry, extra: Object.keys(extra).length ? extra : null });
}

/** `?art=0` — documented escape hatch to skip provider enrichment. */
const skipArt = (req) => req.query.art === "0" || !enrichmentEnabled();

/**
 * Enforce the null policy on a flat list item: string fields are "",
 * array fields are [], identifier/number fields stay null when unknown,
 * art fields (poster/cover/artSource/…) are null when no source has art.
 * Field sets below are THE public list-item contract.
 */
const ITEM_STR = ["key", "slug", "title", "titleRomaji", "titleEnglish", "titleNative", "type", "status", "season", "rating"];
const ITEM_ARR = ["synonyms", "genres"];
const ITEM_NULLABLE = ["anilistId", "malId", "year", "episodes", "score"];
const ITEM_ART_NULLABLE = ["poster", "cover", "artSource"];
const ITEM_DESCRIPTION = ["description"];

function finalizeItem(item = {}) {
  const out = {};
  // v2.3.0: ONE status/type vocabulary — AniList enums (RELEASING, MOVIE…)
  // and lane strings are mapped before anything leaves the API.
  for (const f of ITEM_STR) {
    let v = item[f] === null || item[f] === undefined ? "" : String(item[f]);
    if (f === "status") v = normalizeStatus(v);
    if (f === "type") v = normalizeType(v);
    out[f] = v;
  }
  for (const f of ITEM_ARR) out[f] = Array.isArray(item[f]) ? item[f] : [];
  for (const f of ITEM_NULLABLE) {
    const v = item[f];
    if (v === undefined || v === null || v === "") { out[f] = null; continue; }
    const n = Number(v);
    out[f] = Number.isFinite(n) ? n : null;
  }
  // art fields: explicit null when no provider has art (never "", never missing)
  for (const f of ITEM_ART_NULLABLE) {
    const v = item[f];
    out[f] = v === null || v === undefined || v === "" ? null : String(v);
  }
  for (const f of ITEM_DESCRIPTION) {
    const v = item[f];
    out[f] = v === null || v === undefined ? "" : String(v);
  }
  // extensions ride along after the core fields, same names everywhere
  for (const [k, v] of Object.entries(item)) {
    if (ITEM_STR.includes(k) || ITEM_ARR.includes(k) || ITEM_NULLABLE.includes(k) ||
        ITEM_ART_NULLABLE.includes(k) || ITEM_DESCRIPTION.includes(k)) continue;
    if (v === undefined) continue;
    out[k] = v === null && (k === "sub" || k === "dub" || k === "total") ? 0 : v;
  }
  return out;
}

/**
 * Map a raw catalog/browse item (kaze upstream shapes:
 * slug|poster|title|japaneseTitle|sub|dub|total|type|rating|animeId,
 * spotlight rows +description+rating+quality+date, top-ten/sidebar
 * rows with `name` instead of `title` and a `rank`, upcoming rows
 * with `releaseDate`, schedule rows with `time`/`episode_no`,
 * sidebar rows with `score`/`episodes`) onto the unified list-item
 * shape. Identity is slug-anchored — catalog pages carry no
 * AniList/MAL ids, and we do NOT invent them.
 */
function catalogListItem(raw = {}) {
  if (!raw || typeof raw !== "object") return raw;
  const rawSlug = cleanListingSlug(raw.slug || raw.listingId || "");
  // top-ten / trending-sidebar rows carry the display title as `name`
  const title = raw.title || raw.name || "";
  // Upstream sidebar/list items sometimes carry their own NUMERIC ids in the
  // slug position ("7457", "1642"). A bare number in `slug`/`key` would
  // collide with the numeric-AniList-id key format and resolve to the WRONG
  // anime — so numeric-only slugs fall back to the title-derived slug and the
  // raw id is preserved as the `animeId` extension instead.
  const numericUpstreamId = /^\d+$/.test(rawSlug) ? rawSlug : null;
  const slug = numericUpstreamId ? titleSlug(title) : rawSlug || titleSlug(title);
  // ishi-lane rows carry real AniList/MAL ids; kaze catalog rows do not —
  // take what the row actually has, never invent.
  const item = animeListItem({
    identity: {
      anilistId: raw.anilistId ?? null,
      malId: raw.malId ?? null,
      slug,
      title,
    },
    extra: {
      titleRomaji: raw.japaneseTitle || raw.titleAlt || raw.titleRomaji || "",
      // NOTE: upstream `japaneseTitle` is the ROMAJI alt title (verified
      // live: "Mushoku Tensei III: Isekai Ittara Honki Dasu") — it feeds
      // titleRomaji only. titleNative is never fabricated from it (v2.3.0
      // fix: it used to pollute titleNative with romaji on every row).
      poster: raw.poster || "",
      cover: raw.cover || "",
      type: raw.type || "",
      status: raw.status || "",
      season: raw.season || "",
      year: raw.year ?? null,
      episodes: raw.total ?? raw.episodes ?? null,
      score: raw.score ?? null,
      rating: raw.rating || "",
      description: raw.description || raw.synopsis || "",
      artSource: (raw.poster || raw.cover) ? "upstream" : null,
    },
  });
  if (raw.animeId) item.animeId = String(raw.animeId);
  else if (numericUpstreamId) item.animeId = numericUpstreamId;
  if (raw.sub !== undefined || raw.dub !== undefined || raw.total !== undefined) {
    item.sub = raw.sub ?? 0;
    item.dub = raw.dub ?? 0;
    item.total = raw.total ?? 0;
  }
  // family-specific extras — same names on every endpoint that has them
  if (raw.rank !== undefined && raw.rank !== null && raw.rank !== "") item.rank = Number(raw.rank) || raw.rank;
  if (raw.relation) item.relation = raw.relation;
  if (raw.quality) item.quality = raw.quality;
  if (raw.date) item.releaseDate = raw.date;               // spotlight rows
  if (raw.releaseDate) item.releaseDate = raw.releaseDate; // upcoming rows
  if (raw.time) item.airingTime = raw.time;                // schedule rows
  if (raw.episode_no !== undefined && raw.episode_no !== null) item.airingEpisode = Number(raw.episode_no) || null;
  if (raw.url) item.url = raw.url;
  return finalizeItem(item);
}

// ================================================================ CORE
/**
 * GET /api/search?q=naruto [&page=1]
 * One deduplicated list — romaji/English duplicates are merged silently.
 * Every result carries the unified identity block (key/slug/ids/titles)
 * so any returned entry can be fed straight into any other endpoint.
 */
router.get("/search", wrap(async (req, res) => {
  const q = req.query.q || req.query.keyword || req.query.query;
  if (!q) throw new CustomError("Missing ?q= (search term)", 400);
  const data = await unifiedSearch(q, page(req));
  let results = data.groups
    .map(({ lanes, _first, ...pub }) => finalizeItem(pub))
    // unanchored groups may duplicate an anchored one by slug — keep first only
    .filter((r, i, arr2) => !r.slug || arr2.findIndex((x) => x.slug && x.slug === r.slug) === i);
  // v2.3.0: same art contract as every other listing surface
  await enrichItemList(results, { skipArt: skipArt(req) });
  res.json({ success: true, api: "APIKuoshi", query: q, page: data.page, count: results.length, results });
}));

/**
 * GET /api/suggestions?keyword=one
 * Live typeahead — light and fast. Items follow the unified identity
 * shape (key = slug when that is all a suggestion carries).
 */
router.get("/suggestions", wrap(async (req, res) => {
  const keyword = req.query.keyword || req.query.q;
  if (!keyword) throw new CustomError("Missing ?keyword=", 400);
  const lane = getLane("kaze");
  const raw = await lane.suggestions(keyword);
  const suggestions = (Array.isArray(raw) ? raw : []).map((s) => {
    const slug = cleanListingSlug(s.slug || s.listingId || "") || titleSlug(s.title || "");
    return finalizeItem({
      key: slug,
      slug,
      title: s.title || "",
      titleRomaji: s.titleRomaji || s.japaneseTitle || "",
      titleNative: s.titleNative || "",
      poster: s.poster || "",
      type: s.type || "",
      sub: s.sub ?? 0,
      dub: s.dub ?? 0,
    });
  });
  res.json({ success: true, api: "APIKuoshi", keyword, count: suggestions.length, suggestions });
}));

/**
 * GET /api/resolve?title=frieren
 * Turn ANY identity into the canonical key + confirm playability.
 * Accepts: anilist:<id> | mal:<id> | <numeric id> | <slug> | <title>
 * (romaji / english / native / synonym — colons allowed).
 */
router.get("/resolve", wrap(async (req, res) => {
  const title = req.query.title || req.query.q || req.query.key;
  if (!title) throw new CustomError("Missing ?title= (any key format or title)", 400);

  const { anilistId, malId, slug, canonical } = await canonicalFor(title);
  const key = keyForIds({ anilistId, malId, slug });

  // quick playability probe (both probes are internally cached)
  const kaze = getLane("kaze");
  const [slugMatch, siteIds] = await Promise.allSettled([
    matchSlug(kaze, canonical, slug),
    anilistId
      ? import("../sources/ishi/dist/utils/mapper.js").then((m) => m.getSiteIds(anilistId)).catch(() => null)
      : Promise.resolve(null),
  ]);
  const playable = Boolean(slugMatch.status === "fulfilled" && slugMatch.value) ||
    Boolean(siteIds.status === "fulfilled" && siteIds.value?.siteIds);

  res.json({
    success: true,
    api: "APIKuoshi",
    title,
    found: true,
    playable,
    key,
    anime: publicAnime(canonical),
  });
}));

// ================================================================ ANIME
/**
 * GET /api/anime?key=anilist:154587   (any key format: anilist/mal/
 * numeric/slug/title)
 * Full info for one anime + relations (prequel/sequel/specials/…)
 * + the endpoint map for it.
 */
router.get("/anime", wrap(async (req, res) => {
  const key = keyOf(req);
  const { anilistId, malId, slug, canonical } = await canonicalFor(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });
  const enc = encodeURIComponent(key || canonicalKey);

  // v2.3.0: top-up the canonical entry with AniList's rich detail
  // (synopsis/genres/score/season) so /api/anime and /api/meta carry the
  // SAME depth for the same key — the by-id canonical lookup intentionally
  // stays lean, the detail query fills the rest (6 h cache).
  const detailTopUp = anilistId ? await anilistDetail(anilistId).catch(() => null) : null;
  const extra = detailTopUp
    ? {
        synopsis: detailTopUp.synopsis || "",
        description: detailTopUp.synopsis || "",
        genres: Array.isArray(detailTopUp.genres) ? detailTopUp.genres : [],
        score: detailTopUp.averageScore ?? null,
        season: detailTopUp.season || "",
      }
    : null;

  // relations graph (prequel/sequel/specials/ova/ona/movie/…) — AniList is
  // the only upstream with a typed relations graph; entries follow the
  // unified anime shape and are never dropped for missing ids.
  const relationsRaw = anilistId ? await anilistRelations(anilistId).catch(() => []) : [];
  const relations = relationsBlock(
    (relationsRaw || []).map((r) => ({
      ...animeListItem({ canonical: r, identity: { slug: r.slug || "" } }),
      relation: r.relationType || "related",
    })).map(finalizeItem)
  );

  const anime = publicAnime(canonical, extra);
  // v2.3.0: full art chain on the detail resource — poster/cover/backdrop/
  // banner/logo. enrichAnimeArt keeps the AniList banner when present and
  // only falls back to the TMDB backdrop when it is missing.
  const art = await enrichAnimeArt(anime, { detail: true, skipArt: skipArt(req) });
  Object.assign(anime, art);

  res.json({
    success: true,
    api: "APIKuoshi",
    key: canonicalKey,
    anime,
    relations,
    endpoints: {
      episodes: `/api/anime/episodes?key=${enc}`,
      servers: `/api/anime/servers?key=${enc}&ep=1`,
      watch: `/api/watch?key=${enc}&ep=1`,
      download: `/api/download?key=${enc}&ep=1`,
      meta: `/api/meta?key=${enc}`,
      chain: `/api/chain?key=${enc}&ep=1`,
    },
  });
}));

/**
 * GET /api/anime/episodes?key=...
 * One flat episode list with REAL per-episode titles (when MAL has them).
 *
 * The kaze listing lane returns episode numbers + ids, but only placeholder
 * titles ("Episode 1", "Episode 2", ...). To surface the actual episode
 * NAME (e.g. "The Journey's End", "It Didn't Have to Be Magic…"), we
 * additionally merge MAL's crowd-sourced episode list (via the shared
 * malEpisodeIndex helper in core/chain.js — the SAME index and cache entry
 * /api/chain uses, so an anime's titles are scraped at most once per cache
 * window regardless of which endpoint asks first). Merged fields:
 * `title`, `titleJapanese`, `aired`, `filler`, `recap`.
 *
 * Fallback chain:
 *   1. kaze listing  -> episode numbers + ids + placeholder titles
 *   2. ishi channels -> episode numbers + ids (different slugs)
 *   3. MAL index     -> real per-episode titles, airdate, filler flag
 *   4. If both listing lanes fail but MAL has the episode list, return
 *      the MAL list directly (no playback id, but the client at least
 *      gets the titles).
 */
router.get("/anime/episodes", wrap(async (req, res) => {
  const key = keyOf(req);
  const { anilistId, malId, slug, canonical } = await canonicalFor(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });

  const episodes = await withCache(`episodes:${anilistId ?? slug ?? malId}:v5`, config.cacheSeconds, async () => {
    // ---- 1. primary listing lane (kaze) -----------------------------------
    const kaze = getLane("kaze");
    let primary = null;
    try {
      const match = await matchSlug(kaze, canonical, slug);
      if (match) {
        const list = await kaze.episodes(match.listingId);
        if (list?.length) {
          primary = list.map((e) => ({
            number: Number(e.episode),
            title: e.title || "",           // usually "Episode N" placeholder
            id: e.id ?? null,
            filler: e.isFiller ?? undefined,
            url: e.url || undefined,
          }));
        }
      }
    } catch { /* silent — fall through */ }

    // ---- 2. playback-channel lane (ishi) ---------------------------------
    if (!primary) {
      const ishi = getLane("ishi");
      for (const channel of ishi.channels) {
        try {
          const data = await ishi.episodes(anilistId, malId, channel);
          if (data?.episodes?.length) {
            primary = data.episodes.map((e) => ({
              number: Number(e.episode),
              title: e.title || "",
              id: e.id ?? null,
            }));
            break;
          }
        } catch { /* try next channel */ }
      }
    }

    // ---- 3. MAL per-episode index (shared with /chain) -------------------
    const malIdx = await malEpisodeIndex(canonical?.malId ?? malId ?? null);
    const hasMal = malIdx && Object.keys(malIdx).length > 0;

    // ---- 4. merge ---------------------------------------------------------
    if (primary && primary.length) {
      if (hasMal) {
        return primary.map((ep) => {
          const mal = malIdx[ep.number] || null;
          return {
            ...ep,
            title: mal?.title || ep.title || "",
            titleJapanese: mal?.titleJapanese || "",
            aired: mal?.aired || "",
            filler: mal?.filler ?? ep.filler ?? false,
            recap: mal?.recap || false,
          };
        });
      }
      return primary;
    }

    // ---- 5. fallback: MAL-only list --------------------------------------
    // No kaze/ishi listing worked, but MAL has episode titles — return them.
    if (hasMal) {
      return Object.values(malIdx)
        .sort((a, b) => Number(a.malId) - Number(b.malId))
        .map((m) => ({
          number: Number(m.malId),
          title: m.title || "",
          titleJapanese: m.titleJapanese || "",
          id: null,
          aired: m.aired || "",
          filler: m.filler || false,
          recap: m.recap || false,
          url: m.url || undefined,
        }));
    }

    return [];
  });

  if (!episodes.length) throw new CustomError(`No episode list available for this anime`, 404);

  // ONE canonical episode shape. v2.3.0: the series-poster fallback is no
  // longer applied blindly — the enrichment chain below tries upstream →
  // Kitsu → TMDB first, and only falls back to the series poster when every
  // provider came up empty. A thumbnail nothing could fill is null
  // explicitly, with `thumbSource` reporting where each thumbnail came from.
  const seriesPoster = canonical?.poster || "";
  const shaped = episodes.map((e) => episodeRecord(e, { seriesPoster, seriesFallback: false }));

  // v2.3.0: THE episode-thumbnail enrichment chain (core/enrich.js).
  // Kitsu id is resolved ONCE per anime (malId mapping → title search);
  // TMDB runs only when keyed and uses extractSeasonHint + the MAL air
  // date as the wrong-match sanity check. Bounded concurrency, provider
  // failures degrade to "no data" — never a 5xx, never fabricated art.
  const seriesTitle = canonical?.titleRomaji || canonical?.title || "";
  const seasonHint = seriesTitle ? extractSeasonHint(seriesTitle).season : null;
  const kitsuId = await resolveKitsuId({
    malId: canonical?.malId ?? malId ?? null,
    title: seriesTitle,
  });
  const coverage = { upstream: 0, kitsu: 0, tmdb: 0, poster: 0, none: 0, total: shaped.length };
  if (!skipArt(req)) {
    await mapPool(shaped, async (ep) => {
      if (!ep || ep.number == null) return;
      if (ep.thumbnail) { coverage.upstream++; return; }
      const art = await enrichEpisodeThumb({
        number: ep.number,
        upstreamThumb: "",
        kitsuId,
        seriesTitle,
        seasonHint,
        expectedAired: ep.aired || null,
        seriesPoster,
      });
      ep.thumbnail = art.thumbnail ?? null;
      ep.thumbSource = art.thumbSource ?? null;
      // Kitsu/TMDB titles only fill real gaps — MAL titles (already merged)
      // and real upstream titles always win over placeholders.
      if (art.title && (!ep.title || /^Episode\s*\d+$/i.test(ep.title))) ep.title = art.title;
      if (!ep.aired && art.aired) ep.aired = art.aired;
      coverage[art.thumbSource || "none"] = (coverage[art.thumbSource || "none"] || 0) + 1;
    });
  } else {
    for (const ep of shaped) {
      if (ep.thumbnail) { ep.thumbSource = ep.thumbSource || "upstream"; coverage.upstream++; }
      else { ep.thumbnail = seriesPoster || null; ep.thumbSource = seriesPoster ? "poster" : null; coverage[seriesPoster ? "poster" : "none"]++; }
    }
  }

  res.json({
    success: true,
    api: "APIKuoshi",
    key: canonicalKey,
    poster: seriesPoster || null,
    count: shaped.length,
    enrichment: { tmdb: tmdbEnabled(), coverage },
    episodes: shaped,
  });
}));

/**
 * GET /api/anime/servers?key=...&ep=1 [&type=sub|dub|all]
 * The server list for one episode.
 */
router.get("/anime/servers", wrap(async (req, res) => {
  const key = keyOf(req);
  const ep = parseInt(req.query.ep, 10) || 1;
  const type = String(req.query.type || "all").toLowerCase();
  const { anilistId, malId, slug, canonical } = await canonicalFor(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });

  const servers = await withCache(`servers:${anilistId ?? slug ?? malId}:${ep}:${type}`, config.cacheSeconds, async () => {
    // 1. primary listing lane
    const kaze = getLane("kaze");
    try {
      const match = await matchSlug(kaze, canonical, slug);
      if (match) {
        const list = await kaze.servers(match.listingId, ep);
        if (list?.length) {
          return list
            .map((s) => ({
              name: s?.name || s?.server || "server",
              originalName: s?.originalName || null,
              type: s?.type || null,
              ...(s?.beta ? { beta: true } : {}),
              id: s?.link_id || s?.linkId || s?.id || s?.sourceId || null,
            }))
            .filter((s) => s.id);
        }
      }
    } catch { /* silent — fall through */ }

    // 2. playback-channel lane
    const ishi = getLane("ishi");
    for (const channel of ishi.channels) {
      try {
        const list = await ishi.servers(anilistId, malId, ep, channel);
        const arr = Array.isArray(list) ? list : list?.servers ?? [];
        if (arr.length) {
          return arr
            .map((s) => ({ name: s?.name || "server", originalName: s?.originalName || null, type: s?.type || null, id: s?.sourceId || s?.id || null }))
            .filter((s) => s.id);
        }
      } catch { /* try next channel */ }
    }
    return [];
  });

  if (!servers.length) throw new CustomError(`No servers found for episode ${ep}`, 404);

  res.json({ success: true, api: "APIKuoshi", key: canonicalKey, poster: canonical?.poster || "", episode: ep, count: servers.length, servers });
}));

// ================================================================ PLAYBACK
/**
 * GET /api/watch?key=...&ep=1 [&type=sub|dub|all] [&server=<name hint>]
 * The stream resolver: returns playable links, each with a same-origin
 * proxiedUrl so browsers can play them cross-origin out of the box.
 */
router.get("/watch", wrap(async (req, res) => {
  const key = keyOf(req);
  const ep = parseInt(req.query.ep, 10) || 1;
  const type = ["sub", "dub", "all"].includes(req.query.type) ? req.query.type : "sub";
  const serverHint = req.query.server || null;
  const { anilistId, malId, slug, canonical } = await canonicalFor(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });

  const streams = await withCache(`watch:${anilistId ?? slug ?? malId}:${ep}:${type}:${serverHint || ""}`, 60, async () => {
    const out = [];

    // 1. primary listing lane
    const kaze = getLane("kaze");
    try {
      const match = await matchSlug(kaze, canonical, slug);
      if (match) {
        const data = await kaze.watch(match.listingId, ep, type === "all" ? "all" : type);
        for (const s of data?.streams || []) {
          const pub = publicStream(s, STREAM_REFERER);
          if (pub?.url) out.push(pub);
        }
      }
    } catch (err) {
      console.error(`[APIKUOSHI][watch] primary lane failed:`, err.message);
    }

    // 2. playback-channel lane — always run if we still lack a direct stream
    const hasDirect = out.some((s) => s.kind === "direct");
    if (!hasDirect) {
      const ishi = getLane("ishi");
      for (const channel of ishi.channels) {
        try {
          const data = await ishi.watch(anilistId, malId, ep, type, channel, serverHint);
          for (const s of data?.streams || []) {
            const pub = publicStream(s);
            if (pub?.url) out.push(pub);
          }
        } catch (err) {
          console.error(`[APIKUOSHI][watch] channel failed:`, err.message);
        }
        if (out.some((s) => s.kind === "direct")) break; // direct stream wins
      }
    }
    return out;
  });

  if (!streams.length) {
    throw new CustomError(`No playable streams available for episode ${ep} right now`, 502);
  }

  // best = first direct stream matching the requested type, else first direct
  const direct = streams.filter((s) => s.kind === "direct");
  const pool = direct.length ? direct : streams;
  const preferred = pool.find((s) => type === "all" || !s.type || s.type === type) || pool[0];

  res.json({
    success: true,
    api: "APIKuoshi",
    key: canonicalKey,
    thumbnail: canonical?.poster || "",
    episode: ep,
    type,
    stream: preferred,
    streams,
  });
}));

/**
 * GET /api/download?key=...&ep=1
 * Download links for one episode.
 */
router.get("/download", wrap(async (req, res) => {
  const key = keyOf(req);
  const ep = parseInt(req.query.ep, 10) || 1;
  const { anilistId, malId, slug, canonical } = await canonicalFor(key);

  const kaze = getLane("kaze");
  const match = await matchSlug(kaze, canonical, slug);
  if (!match) throw new CustomError(`No download links available for episode ${ep}`, 404);
  const data = await kaze.download(match.listingId, ep);
  const downloads = Array.isArray(data) ? data : data?.downloads ?? [];
  if (!downloads.length) throw new CustomError(`No download links available for episode ${ep}`, 404);

  res.json({ success: true, api: "APIKuoshi", key: keyForIds({ anilistId, malId, slug }), episode: ep, count: downloads.length, downloads });
}));

/**
 * GET /api/chain?q=... | key=... | id=... | slug=... [&ep=1] [&type=sub] [&probe=0] [&all=1]
 * THE STREAMING CHAIN — one call, whole journey, nested functions:
 *   resolve -> info -> episodes -> servers -> streams -> probe -> episode-titles
 * Every hop is timed and reported in steps[]. Every stream URL is probed
 * against the real CDN and the response ends with a ready-to-play `best`
 * stream (proxied through the built-in CORS proxies). The response also
 * carries the requested episode's REAL title (MAL-backed, same source as
 * /api/anime/episodes): see `episode` and top-level `episodeTitle`.
 */
router.get("/chain", wrap(async (req, res) => {
  const q = req.query.q || null;
  const key = req.query.key || req.query.id || null;
  const slug = req.query.slug || null;
  if (!q && !key && !slug) {
    throw new CustomError("Provide one of: ?q=<search> | ?key=<anime key> | ?id=<anilist id> | ?slug=<listing slug>", 400);
  }
  const result = await runStreamingChain({
    q,
    key,
    slug,
    ep: parseInt(req.query.ep, 10) || 1,
    type: req.query.type || "sub",
    channel: req.query.channel || null,
    probe: req.query.probe !== "0",
    all: req.query.all === "1",
  });
  res.json({ success: true, api: "APIKuoshi", ...result });
}));

// ================================================================ BROWSE
// Discovery surface. List endpoints always answer with
// { success, api, kind, count, results: [...] } where every entry follows
// the unified anime list-item shape (key/slug/identity + extensions).
// Object-shaped payloads (home sections, top-ten groups, seasons maps)
// answer with { success, api, kind, data } — ONE nesting level, entries
// inside normalized the same way.

/**
 * Per-page slug dedup: upstream layouts occasionally repeat the same
 * listing twice (mobile+desktop blocks). Keep the first occurrence.
 */
function dedupeBySlug(items) {
  const seen = new Set();
  return items.filter((it) => {
    const id = it?.slug || it?.key || JSON.stringify(it).slice(0, 120);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Does this payload look like ONE anime row (random / info-style)? */
const looksLikeAnimeRow = (d) =>
  d && typeof d === "object" && !Array.isArray(d) &&
  typeof d.title === "string" && d.title &&
  (d.slug || d.poster || d.listingId);

const sendList = async (res, kind, result, { page: pageNum = null, extraBody = null, skipArt: artOff = false } = {}) => {
  let items = result;
  let pagination = null;

  // the kaze passthrough wrapper is { lane, kind, data, totalPages?, letter? }
  if (items && !Array.isArray(items) && typeof items === "object" && "data" in items && ("lane" in items || "kind" in items)) {
    if (Number.isFinite(Number(items.totalPages))) {
      pagination = {
        page: pageNum || 1,
        totalPages: Number(items.totalPages),
        hasNextPage: (pageNum || 1) < Number(items.totalPages),
      };
    }
    items = items.data;
  }
  // generic container unwrap
  if (items && !Array.isArray(items) && typeof items === "object") {
    if (Array.isArray(items.data)) items = items.data;
    else if (Array.isArray(items.results)) items = items.results;
  }

  if (Array.isArray(items)) {
    let results = items.map(stripInternal).map(catalogListItem);
    results = dedupeBySlug(results);
    // v2.3.0: the ONE art enrichment chain — upstream → Kitsu → TMDB,
    // bounded concurrency, provider failures degrade to "no data".
    const coverage = await enrichItemList(results, { skipArt: artOff });
    const body = { success: true, api: "APIKuoshi", kind, count: results.length, results };
    if (pagination) body.pagination = pagination;
    body.enrichment = { tmdb: tmdbEnabled(), coverage };
    if (extraBody) Object.assign(body, extraBody);
    res.json(body);
    return;
  }

  // object-shaped payload — normalize any anime-item arrays inside it
  let data = items && typeof items === "object" ? stripInternal(items) : items;
  const animeArrays = [];
  let singleAnime = false;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    // seasons/watch-order style: { animeId, slug, totalSeasons|totalRelated, seasons|related: [...] }
    for (const key of ["seasons", "related", "entries"]) {
      if (Array.isArray(data[key])) {
        data[key] = dedupeBySlug(data[key].map(catalogListItem));
        animeArrays.push(data[key]);
      }
    }
    // home/section style: arrays nested under section keys
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "slug" in v[0]) {
        data[k] = dedupeBySlug(v.map(catalogListItem));
        animeArrays.push(data[k]);
      }
    }
    // v2.3.0: single-anime payloads (random) get the SAME canonical shape
    // as every list item — they used to leak the raw extractor object.
    if (!animeArrays.length && looksLikeAnimeRow(data)) {
      data = catalogListItem(data);
      singleAnime = true;
    }
  }
  let enrichment = null;
  if (!artOff) {
    if (singleAnime) {
      // single-anime view (random): full detail-level art chain
      const art = await enrichAnimeArt(data, { detail: true });
      Object.assign(data, art);
    } else if (animeArrays.length) {
      enrichment = await enrichItemList(animeArrays.flat(), {});
    }
  }
  const body = { success: true, api: "APIKuoshi", kind, data };
  if (enrichment) body.enrichment = { tmdb: tmdbEnabled(), coverage: enrichment };
  if (pagination) body.pagination = pagination;
  if (extraBody) Object.assign(body, extraBody);
  res.json(body);
};

const browseList = (kazeFn, { ishiFallback = null, label } = {}) =>
  wrap(async (req, res) => {
    const result = await withFallback(
      async (lane) => {
        if (lane.id === "kaze") {
          const out = await kazeFn(lane, req);
          return out || null;
        }
        if (lane.id === "ishi" && ishiFallback) return ishiFallback(lane, req);
        return null;
      },
      { label }
    );
    await sendList(res, label, result, {
      page: page(req),
      skipArt: skipArt(req),
      extraBody: (req.ignoredParams?.length || req.invalidParams?.length)
        ? {
            ...(req.ignoredParams?.length ? { ignoredParams: req.ignoredParams } : {}),
            ...(req.invalidParams?.length ? { invalidParams: req.invalidParams } : {}),
          }
        : null,
    });
  });

/**
 * Variant of `browseList` that NEVER 502s on an empty result.
 *
 * Use this for endpoints where "no matches" is a legitimate client-facing
 * state, not a server failure — e.g. /api/filter with restrictive params,
 * or /api/genre with multiple genres that yield no overlap.
 *
 * Behaviour:
 *   - Try the kaze lane directly (no ishi fallback for catalog filters).
 *   - On any error or empty result, respond 200 with count: 0 instead of 502.
 */
const browseListAllowEmpty = (kazeFn, { label } = {}) =>
  wrap(async (req, res) => {
    const kaze = getLane("kaze");
    let result = null;
    try {
      result = await kazeFn(kaze, req);
    } catch (err) {
      // Log for operators but never surface as 502 — empty filter result is valid.
      console.error(`[APIKUOSHI][${label}] kaze failed:`, err.message);
    }
    await sendList(res, label, result || { data: [] }, {
      page: page(req),
      skipArt: skipArt(req),
      extraBody: req.ignoredParams?.length ? { ignoredParams: req.ignoredParams } : null,
    });
  });

router.get("/home", browseList(
  (kaze) => kaze.home(),
  { ishiFallback: async (ishi) => ({ data: await ishi.airing() }), label: "home" }
));

router.get("/spotlight", browseList(
  (kaze) => kaze.spotlight(),
  { ishiFallback: async (ishi) => ({ data: (await ishi.airing()).slice(0, 12) }), label: "spotlight" }
));

router.get("/trending", browseList(
  (kaze) => kaze.trending(),
  { ishiFallback: async (ishi) => ({ data: (await ishi.airing()).slice(0, 24) }), label: "trending" }
));

router.get("/trending-sidebar", browseList((kaze) => kaze.trendingSidebar(), { label: "trending-sidebar" }));

router.get("/top-ten", browseList((kaze) => kaze.topTen(), { label: "top-ten" }));

/**
 * GET /api/top-rankings?sort=top|week|month [&page=]
 * Ranking family — carries `rank` on top of the canonical shape.
 * v2.3.0: unknown sort values are no longer silently mapped to the
 * default — they are reported in `invalidParams[]` and the default
 * ("top") applies, so clients can detect typos.
 */
const RANKING_SORTS = ["top", "week", "month"];
router.get("/top-rankings", (req, res, next) => {
  const sort = String(req.query.sort || "top").toLowerCase() || "top";
  if (!RANKING_SORTS.includes(sort)) {
    req.invalidParams = [`${sort} (valid sorts: ${RANKING_SORTS.join(", ")})`];
    req.query.sort = "top";
  } else {
    req.query.sort = sort;
  }
  next();
}, browseList(
  (kaze, req) => kaze.topRankings(req.query.sort),
  { label: "top-rankings" }
));

router.get("/popular", browseList(
  (kaze) => kaze.popular(),
  { ishiFallback: async (ishi) => ({ data: (await ishi.airing()).slice(0, 24) }), label: "popular" }
));

/**
 * GET /api/random
 * One random anime in the FULL canonical detail shape (v2.3.0: it used
 * to leak the raw extractor object). Query params the site-wide random
 * endpoint cannot honour (?genre=, ?type=, …) are reported in
 * `ignoredParams[]` instead of being silently dropped.
 */
router.get("/random", (req, res, next) => {
  const honoured = ["art"];
  const unknown = Object.keys(req.query).filter((k) => !honoured.includes(k));
  if (unknown.length) req.ignoredParams = unknown;
  next();
}, browseList((kaze, req) => kaze.random(), { label: "random" }));

router.get("/upcoming", browseList((kaze) => kaze.upcoming(), { label: "upcoming" }));

router.get("/completed", browseList((kaze, req) => kaze.completed(page(req)), { label: "completed" }));

router.get("/new-release", browseList((kaze, req) => kaze.newRelease(page(req)), { label: "new-release" }));

router.get("/newly-added", browseList((kaze, req) => kaze.newlyAdded(page(req)), { label: "newly-added" }));

router.get("/latest-updated", browseList((kaze, req) => kaze.latestUpdated(page(req)), { label: "latest-updated" }));

/**
 * GET /api/recently-updated?tab=all|sub|dub
 * v2.3.0: the tab is validated — garbage tabs used to silently return
 * the "all" view upstream; now they 400 with the valid values listed
 * (same contract as /api/az-list letters and /api/meta/season).
 */
const RECENT_TABS = ["all", "sub", "dub"];
router.get("/recently-updated", wrap(async (req, res, next) => {
  const tab = String(req.query.tab || "all").toLowerCase() || "all";
  if (!RECENT_TABS.includes(tab)) {
    throw new CustomError(`Invalid tab "${req.query.tab}" — use one of: ${RECENT_TABS.join(", ")}`, 400);
  }
  req.query.tab = tab;
  next();
}), browseList(
  (kaze, req) => kaze.recentlyUpdated(req.query.tab),
  { label: "recently-updated" }
));

router.get("/schedule", browseList((kaze) => kaze.schedule(), { label: "schedule" }));

/**
 * GET /api/airing [&page=]
 * Currently airing anime.
 */
router.get("/airing", wrap(async (req, res) => {
  const result = await withFallback(
    async (lane) => {
      if (lane.id === "ishi") return { data: await lane.airing() };
      if (lane.id === "kaze") return lane.schedule();
      return null;
    },
    { label: "airing" }
  );
  await sendList(res, "airing", result, { skipArt: skipArt(req) });
}));

// ================================================================ CATALOG
// Supported upstream letters: a-z, 0-9 and "all". Garbage letters used to
// bubble up as 502s — they get a clear 400 now.
router.get("/az-list/:letter", wrap(async (req, res, next) => {
  const letter = String(req.params.letter || "all").toLowerCase();
  if (!/^[a-z0-9]$/.test(letter) && letter !== "all") {
    throw new CustomError(`Invalid letter "${req.params.letter}" — use a-z, 0-9 or "all"`, 400);
  }
  req.params.letter = letter;
  next();
}), browseList(
  (kaze, req) => kaze.azList(req.params.letter, page(req)),
  { label: "az-list" }
));

/**
 * GET /api/filter — every supported filter param is forwarded; UNKNOWN
 * params are reported back in `ignoredParams[]` instead of being silently
 * dropped, so clients can detect typos (e.g. ?genres= vs ?genre=).
 */
const FILTER_PARAMS = ["keyword", "genre", "type", "status", "season", "language",
  "rating", "animesource", "source", "sort", "year", "ep_min", "ep_max",
  "exclude_watchlist", "page"];

router.get("/filter", browseListAllowEmpty(
  (kaze, req) => {
    const unknown = Object.keys(req.query).filter((k) => !FILTER_PARAMS.includes(k));
    if (unknown.length) req.ignoredParams = unknown;
    return kaze.filter({
    keyword: req.query.keyword || "",
    genre: req.query.genre || "",
    type: req.query.type || "",
    status: req.query.status || "",
    season: req.query.season || "",
    language: req.query.language || "",
    rating: req.query.rating || "",
    source: req.query.animesource || req.query.source || "",
    sort: req.query.sort || "",
    year: req.query.year || "",
    epMin: req.query.ep_min || "",
    epMax: req.query.ep_max || "",
    excludeWatchlist: req.query.exclude_watchlist === "1" || req.query.exclude_watchlist === "true",
    page: page(req),
    });
  },
  { label: "filter" }
));

/**
 * GET /api/genre/:genre
 * Single-genre path delegates to the kaze category page (e.g. /genre/action).
 * Multi-genre path (comma-separated, e.g. /api/genre/action,comedy) routes
 * through kaze.filter() which the upstream /filter endpoint supports natively
 * via repeated genre[]=ID query params.
 *
 * Both paths use browseListAllowEmpty so an unmatched genre never 502s —
 * the client simply gets { success: true, count: 0, results: [] }.
 */
router.get("/genre/:genre", browseListAllowEmpty(
  (kaze, req) => {
    const genreParam = req.params.genre || "";
    if (genreParam.includes(",")) {
      // Multi-genre: route through the filter extractor (supports genre[]=ID).
      return kaze.filter({
        genre: genreParam,
        page: page(req),
      });
    }
    return kaze.category("genre", genreParam, page(req));
  },
  { label: "genre" }
));

/**
 * GET /api/type/:type & GET /api/status/:status
 * v2.3.0: routed through the allow-empty wrapper — an unknown type/status
 * is a legitimate empty result (200, count 0), never a 502. Common status
 * aliases (airing/ongoing/completed/upcoming) are mapped by the lane.
 */
router.get("/type/:type", browseListAllowEmpty(
  (kaze, req) => kaze.category("type", req.params.type, page(req)),
  { label: "type" }
));

router.get("/status/:status", browseListAllowEmpty(
  (kaze, req) => kaze.status(req.params.status, page(req)),
  { label: "status" }
));

/**
 * Resolve the :slug param of seasons/watch-order routes — which now accept
 * ANY key format (listing slug, anilist:<id>, mal:<id>, numeric id or a
 * plain title) — into candidate kaze listing slugs, best first. Candidates
 * are tried in order by the caller: upstream occasionally keeps stale
 * listings in search while their watch pages 404, so a single "best match"
 * is not enough.
 */
async function listingSlugsFor(param, max = 3) {
  const { slug, canonical } = await canonicalFor(param);
  const candidates = [];
  const push = (s) => {
    const c = cleanListingSlug(s || "");
    if (c && !candidates.includes(c)) candidates.push(c);
  };
  if (slug) push(slug);

  const kaze = getLane("kaze");
  const { titleSimilarity, titleExactness } = await import("../core/titles.js");
  const query = canonical?.titleRomaji || canonical?.title || titleFromSlug(slug || "") || String(param);
  try {
    const results = (await kaze.search(query)) || [];
    results
      .map((r) => ({ r, s: Math.max(
        titleSimilarity(r.title, canonical?.titleRomaji || query),
        titleSimilarity(r.title, canonical?.titleEnglish || ""),
        r.titleAlt ? titleSimilarity(r.titleAlt, canonical?.titleRomaji || query) : 0
      ) }))
      .filter((x) => x.s >= (config.dedupThreshold || 78) - 5)
      // v2.2.1: exact-title tie-break so upstream order cannot put a
      // near-identical sequel ("Steins;Gate 0") ahead of the requested show
      .sort((a, b) => (b.s - a.s) ||
        Number(titleExactness(query, b.r.title)) - Number(titleExactness(query, a.r.title)))
      .slice(0, max)
      .forEach((x) => push(x.r.listingId));
  } catch { /* search unavailable — work with what we have */ }

  if (!candidates.length) {
    const match = await matchSlug(kaze, canonical, slug).catch(() => null);
    if (match) push(match.listingId);
  }
  if (!candidates.length) {
    throw new CustomError(
      `No listing found for "${param}" — seasons/watch-order need a listing this catalog can reach`,
      404
    );
  }
  return candidates.slice(0, max);
}

/**
 * GET /api/seasons/:slug — the seasons/specials block for one anime.
 * :slug accepts any key format. Entries follow the unified list-item shape
 * (slug always preserved, key = slug when that's all upstream gives us) and
 * are grouped by relation bucket (prequel/sequel/specials/ova/ona/movie/…).
 */
router.get("/seasons/:slug", wrap(async (req, res) => {
  const candidates = await listingSlugsFor(req.params.slug);
  const kaze = getLane("kaze");
  let raw = null;
  let usedSlug = null;
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      raw = await kaze.seasons(candidate);
      const list = raw?.data?.seasons ?? raw?.seasons;
      if (Array.isArray(list) && list.length) { usedSlug = candidate; break; }
      if (!usedSlug) usedSlug = candidate;
    } catch (err) {
      lastErr = err;
    }
  }
  const seasonsRaw = raw?.data?.seasons ?? raw?.seasons;
  const seasons = (Array.isArray(seasonsRaw) ? seasonsRaw : []).map(catalogListItem);
  if (!seasons.length && candidates.length && usedSlug === candidates[0] && lastErr) {
    throw new CustomError(`Season data unavailable for "${usedSlug}" (${lastErr.message})`, 502);
  }
  // v2.3.0: related entries are real resources — same art contract as
  // every other listing surface (slug always preserved, poster/cover filled).
  await enrichItemList(seasons, { skipArt: skipArt(req) });

  res.json({
    success: true,
    api: "APIKuoshi",
    kind: "seasons",
    key: keyForIds({ slug: usedSlug || candidates[0] }),
    slug: usedSlug || candidates[0],
    totalSeasons: seasons.length,
    count: seasons.length,
    seasons,
    data: { slug: usedSlug || candidates[0], totalSeasons: seasons.length, seasons },
  });
}));

/**
 * GET /api/watch-order/:slug — related anime + suggested watch order.
 * Same key flexibility and unified entry shape as /api/seasons; every entry
 * keeps its upstream relation label normalized into the shared buckets
 * (prequel/sequel/specials/ova/ona/movie/sideStory/alternative/…).
 */
router.get("/watch-order/:slug", wrap(async (req, res) => {
  const candidates = await listingSlugsFor(req.params.slug);
  const kaze = getLane("kaze");
  let raw = null;
  let usedSlug = null;
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      raw = await kaze.watchOrder(candidate);
      const list = raw?.data?.related ?? raw?.related;
      if (Array.isArray(list) && list.length) { usedSlug = candidate; break; }
      if (!usedSlug) usedSlug = candidate;
    } catch (err) {
      lastErr = err;
    }
  }
  const relatedRaw = raw?.data?.related ?? raw?.related;
  const related = (Array.isArray(relatedRaw) ? relatedRaw : []).map(catalogListItem);
  if (!related.length && candidates.length && usedSlug === candidates[0] && lastErr) {
    throw new CustomError(`Watch-order data unavailable for "${usedSlug}" (${lastErr.message})`, 502);
  }
  // v2.3.0: same art contract for watch-order entries
  await enrichItemList(related, { skipArt: skipArt(req) });
  res.json({
    success: true,
    api: "APIKuoshi",
    kind: "watch-order",
    key: keyForIds({ slug: usedSlug || candidates[0] }),
    slug: usedSlug || candidates[0],
    totalRelated: related.length,
    count: related.length,
    related,
    groups: relationsBlock(related).groups,
    data: { slug: usedSlug || candidates[0], totalRelated: related.length, related },
  });
}));

// ================================================================ META
// Rich canonical metadata + MAL-shaped views. Every endpoint here emits the
// SAME unified identity (key/slug/ids/titles) built by core/shape.js.

router.get("/meta", wrap(async (req, res) => {
  const key = keyOf(req);
  const { anilistId, malId, slug, canonical } = await canonicalFor(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });
  const detail = anilistId ? await anilistDetail(anilistId).catch(() => null) : null;
  let indexed = null;
  try {
    if (anilistId) {
      const { getSiteIds } = await import("../sources/ishi/dist/utils/mapper.js");
      indexed = await getSiteIds(anilistId);
    }
  } catch { /* mapper offline */ }

  // relations graph — same block as /api/anime (prequel/sequel/specials/…)
  const relationsRaw = anilistId ? await anilistRelations(anilistId).catch(() => []) : [];
  const relations = relationsBlock(
    (relationsRaw || []).map((r) => ({
      ...animeListItem({ canonical: r, identity: { slug: r.slug || "" } }),
      relation: r.relationType || "related",
    })).map(finalizeItem)
  );

  const anime = publicAnime(detail || canonical);
  // v2.3.0: full art chain (poster/cover/backdrop/banner/logo) — same values
  // /api/anime emits for the same key, so the two detail surfaces never diverge.
  const art = await enrichAnimeArt(anime, { detail: true, skipArt: skipArt(req) });
  Object.assign(anime, art);

  const enc = encodeURIComponent(key || canonicalKey);
  res.json({
    success: true,
    api: "APIKuoshi",
    key: canonicalKey,
    anime,
    relations,
    availability: {
      indexed: Boolean(indexed?.siteIds),
      watch: `/api/watch?key=${enc}&ep=1`,
      chain: `/api/chain?key=${enc}&ep=1`,
    },
  });
}));

router.get("/meta/characters", wrap(async (req, res) => {
  const { anilistId, malId, slug } = await canonicalFor(keyOf(req));
  const characters = anilistId
    ? await anilistCharacters(anilistId, parseInt(req.query.limit, 10) || 24)
    : [];
  res.json({
    success: true,
    api: "APIKuoshi",
    key: keyForIds({ anilistId, malId, slug }),
    count: characters.length,
    characters,
  });
}));

/**
 * GET /api/meta/recommendations?key=<any key format> [&limit=12]
 *
 * THE ANILIST-ASSUMPTION FIX:
 * Recommendations are merged from BOTH upstreams and normalized to the
 * unified list-item shape — an entry that only carries a MAL id keeps its
 * mal:<id> key, an entry that only carries a title still resolves through
 * its slug. NOTHING is dropped for lacking an AniList id, and AniList
 * being down no longer empties the whole list (MAL recommendations keep
 * flowing; the request identity itself degrades via canonicalFor).
 *
 * Dedup: when the same MAL id shows up from both sources the entries are
 * merged (AniList fields win, MAL votes ride along as `votes`).
 */
router.get("/meta/recommendations", wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
  const { anilistId, malId, slug, canonical } = await canonicalFor(keyOf(req));
  const canonicalKey = keyForIds({ anilistId, malId, slug });

  const ishi = getLane("ishi");
  const [alRes, malRes] = await Promise.allSettled([
    anilistId ? anilistRecommendations(anilistId, limit) : Promise.resolve([]),
    canonical?.malId || malId
      ? ishi?.malRecommendations?.(parseInt(canonical?.malId ?? malId, 10)) ?? Promise.resolve([])
      : Promise.resolve([]),
  ]);

  const alRecs = alRes.status === "fulfilled" ? alRes.value || [] : [];
  const malRecs = malRes.status === "fulfilled" ? malRes.value || [] : [];

  const merged = [];
  const byMal = new Map();
  const byAnilist = new Map();

  // 1. AniList recommendations (carry anilistId + usually malId)
  for (const r of alRecs) {
    const item = finalizeItem({
      ...animeListItem({ canonical: r }),
      rating: r.rating ?? null,
      source: "anilist",
    });
    merged.push(item);
    if (r.anilistId) byAnilist.set(String(r.anilistId), item);
    if (r.malId) byMal.set(String(r.malId), item);
  }

  // 2. MAL recommendations — NEVER dropped, even with only a MAL id or title
  for (const r of malRecs) {
    const rMalId = parseInt(r.animeId, 10) || null;
    const dupe = rMalId ? byMal.get(String(rMalId)) : null;
    if (dupe) {
      // same recommendation from both sources — merge, AniList fields win
      if (r.votes != null) dupe.votes = r.votes;
      continue;
    }
    const slugFor = titleSlug(r.title || "");
    const item = finalizeItem({
      ...animeListItem({
        identity: { anilistId: null, malId: rMalId, slug: slugFor, title: r.title || "" },
        extra: { poster: r.image || "", type: "", year: null, episodes: null },
      }),
      votes: r.votes ?? null,
      source: "mal",
    });
    merged.push(item);
    if (rMalId) byMal.set(String(rMalId), item);
  }

  // best-effort: AniList entries without a poster keep the MAL image when known
  for (const item of merged) {
    if (!item.poster && item.malId) {
      const malTwin = byMal.get(String(item.malId));
      if (malTwin?.poster) item.poster = malTwin.poster;
    }
  }

  // sort: AniList rating first, then MAL votes, keep stable
  merged.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || (Number(b.votes) || 0) - (Number(a.votes) || 0));
  const recommendations = merged.slice(0, limit);

  // v2.3.0: recommendations are real resources — same art contract as every
  // other listing (poster gaps filled via Kitsu/MAL id, then TMDB title match).
  await enrichItemList(recommendations, { skipArt: skipArt(req) });

  res.json({
    success: true,
    api: "APIKuoshi",
    key: canonicalKey,
    count: recommendations.length,
    sources: {
      anilist: alRecs.length,
      mal: malRecs.length,
    },
    recommendations,
  });
}));

/**
 * GET /api/meta/season?season=WINTER&year=2024 [&page=1]
 * Seasonal anime grid. Invalid seasons/years now 400 clearly instead of
 * silently returning an empty upstream result.
 */
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
router.get("/meta/season", wrap(async (req, res) => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const season = String(req.query.season || (month <= 3 ? "WINTER" : month <= 6 ? "SPRING" : month <= 9 ? "SUMMER" : "FALL")).toUpperCase();
  if (!SEASONS.includes(season)) {
    throw new CustomError(`Invalid season "${req.query.season}" — use one of: ${SEASONS.join(", ")}`, 400);
  }
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  if (year < 1960 || year > now.getFullYear() + 2) {
    throw new CustomError(`Year ${year} out of range (1960–${now.getFullYear() + 2})`, 400);
  }
  const data = await anilistSeason(season, year, page(req));
  const results = (data.results || data.data || [])
    .map((m) => animeListItem({ canonical: m }))
    .map(finalizeItem);
  // v2.3.0: same art contract as every other listing surface
  await enrichItemList(results, { skipArt: skipArt(req) });
  const pageInfo = data.pageInfo || null;
  const body = {
    success: true,
    api: "APIKuoshi",
    season,
    year,
    count: results.length,
    results,
  };
  if (pageInfo?.lastPage) {
    body.pagination = {
      page: pageInfo.currentPage || page(req),
      totalPages: pageInfo.lastPage,
      hasNextPage: Boolean(pageInfo.hasNextPage),
    };
  }
  res.json(body);
}));

/**
 * GET /api/meta/mal?key=mal:52991 [&episodes=1]
 * MyAnimeList-shaped details (queued + cached internally).
 * The key in the response is ALWAYS the canonical mal:<id> resource key.
 */
router.get("/meta/mal", wrap(async (req, res) => {
  const ishi = getLane("ishi");
  const key = String(keyOf(req) || "").trim();
  if (!key) throw new CustomError("Missing ?key= (use mal:<id> or anilist:<id> or a title)", 400);

  let malId = null;
  let identity = { anilistId: null, malId: null, slug: "" };
  if (/^mal:\d+$/i.test(key)) {
    malId = parseInt(key.split(":")[1], 10);
    identity.malId = malId;
  } else {
    const resolved = await canonicalFor(key);
    malId = resolved.canonical?.malId ?? resolved.malId ?? null;
    identity = { anilistId: resolved.anilistId, malId: resolved.malId, slug: resolved.slug };
    if (!malId) throw new CustomError(`No MAL id known for ${key}`, 404);
  }

  const details = await ishi.malDetails(malId);
  if (!details) throw new CustomError(`Anime ${malId} not found on MAL`, 404);

  const payload = {
    success: true,
    api: "APIKuoshi",
    key: keyForIds({ ...identity, malId }),
    malId,
    anime: animeListItem({ mal: details, identity }),
    mal: details,
  };

  if (req.query.episodes === "1") {
    payload.episodes = await ishi.malEpisodes(malId, page(req)).catch(() => null);
  }
  res.json(payload);
}));

router.get("/meta/external", wrap(async (req, res) => {
  const ishi = getLane("ishi");
  const key = String(keyOf(req) || "").trim();
  if (!key) throw new CustomError("Missing ?key=", 400);

  let malId = null;
  let identity = { anilistId: null, malId: null, slug: "" };
  if (/^mal:\d+$/i.test(key)) {
    malId = parseInt(key.split(":")[1], 10);
    identity.malId = malId;
  } else {
    const resolved = await canonicalFor(key);
    malId = resolved.canonical?.malId ?? resolved.malId ?? null;
    identity = { anilistId: resolved.anilistId, malId: resolved.malId, slug: resolved.slug };
  }
  if (!malId) throw new CustomError(`No MAL id known for ${key}`, 404);

  const [external, streaming] = await Promise.allSettled([
    ishi.malExternalLinks(malId),
    ishi.malStreaming(malId),
  ]);
  res.json({
    success: true,
    api: "APIKuoshi",
    key: keyForIds({ ...identity, malId }),
    malId,
    externalLinks: external.status === "fulfilled" ? external.value ?? [] : [],
    streamingPlatforms: streaming.status === "fulfilled" ? streaming.value ?? [] : [],
  });
}));

/**
 * GET /api/meta/trending
 * Top-banners view of what's airing now — same unified list shape as
 * every other browse surface.
 */
router.get("/meta/trending", wrap(async (req, res) => {
  const result = await withFallback(
    async (lane) => {
      if (lane.id === "ishi" && lane.airingBanners) return { data: await lane.airingBanners() };
      if (lane.id === "ishi") return { data: await lane.airing() };
      if (lane.id === "kaze") return lane.trending();
      return null;
    },
    { label: "meta-trending" }
  );
  sendList(res, "trending", result);
}));

// ================================================================ INFRA
// Playback infrastructure: restreams m3u8 playlists and media so browsers
// can play them cross-origin.
//
// Token-gated CDNs (nexabloom/qeltrix family — 32-hex path pairs) are
// RE-TOKENIZED on every hop: the 90 s HMAC TTL would break mid-playback
// if a playlist-embedded stale token were reused. Each proxied variant/
// segment request re-enters these handlers, so a fresh token is always
// minted before the upstream fetch.

const PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

router.get("/proxy/hls", wrap(async (req, res) => {
  const raw = req.query.url;
  if (!raw || !/^https?:\/\//i.test(raw)) throw new CustomError("Missing/invalid ?url= (absolute http(s) m3u8 URL)", 400);
  const ref = req.query.ref || null;
  const url = withCdnToken(raw);

  const r = await axios.get(url, {
    responseType: "text",
    timeout: 20000,
    headers: { "User-Agent": PROXY_UA, ...(ref ? { Referer: ref } : {}) },
  });

  const body = String(r.data || "");
  const base = new URL(url.split("?")[0]);
  const rewritten = body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // rewrite URIs inside #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          const abs = new URL(u, base).toString();
          return u.endsWith(".m3u8") || !/\.\w{2,4}(\?|$)/.test(u)
            ? `URI="/api/proxy/hls?url=${encodeURIComponent(abs)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}"`
            : `URI="/api/proxy/video?url=${encodeURIComponent(abs)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}"`;
        });
      }
      const abs = new URL(t, base).toString();
      if (t.includes(".m3u8")) return `/api/proxy/hls?url=${encodeURIComponent(abs)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
      return `/api/proxy/video?url=${encodeURIComponent(abs)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
    })
    .join("\n");

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(rewritten);
}));

router.get("/proxy/video", wrap(async (req, res) => {
  const raw = req.query.url;
  if (!raw || !/^https?:\/\//i.test(raw)) throw new CustomError("Missing/invalid ?url= (absolute http(s) URL)", 400);
  const ref = req.query.ref || null;
  const url = withCdnToken(raw);

  const upstream = await axios.get(url, {
    responseType: "stream",
    timeout: 30000,
    headers: {
      "User-Agent": PROXY_UA,
      ...(ref ? { Referer: ref } : {}),
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
  });

  res.setHeader("Access-Control-Allow-Origin", "*");
  if (upstream.headers["content-type"]) res.setHeader("Content-Type", upstream.headers["content-type"]);
  if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
  if (upstream.headers["content-range"]) res.setHeader("Content-Range", upstream.headers["content-range"]);
  res.status(upstream.status);
  upstream.data.pipe(res);
}));

router.get("/proxy/subtitle", wrap(async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new CustomError("Missing/invalid ?url=", 400);
  const ref = req.query.ref || null;
  const r = await axios.get(url, {
    responseType: "text",
    timeout: 20000,
    headers: { "User-Agent": PROXY_UA, ...(ref ? { Referer: ref } : {}) },
  });
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(String(r.data || ""));
}));

export default router;
