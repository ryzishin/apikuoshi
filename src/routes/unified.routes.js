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
  anilistRelations, anilistFranchise,
} from "../core/anilist.js";
import { getLane } from "../core/registry.js";
import { runStreamingChain, malEpisodeIndex } from "../core/chain.js";
import { canonicalFor, matchSlug, resolveFlexible } from "../core/keys.js";
import { CustomError } from "../core/errors.js";
import { withCache } from "../core/cache.js";
import { convertSubtitle, detectSubtitleFormat } from "../core/subtitles.js";
import { withCdnToken } from "../sources/kaze/helper/cdn.helper.js";
import config from "../config.js";
import {
  canonicalAnime, animeListItem, episodeRecord, relationsBlock,
  keyForIds, cleanListingSlug, titleSlug, titleFromSlug, normalizeStatus, normalizeType,
  bucketForRelation, RELATION_ORDER, normalizeRelation,
} from "../core/shape.js";
import {
  enrichAnimeArt, enrichItemList, enrichEpisodeThumb, enrichEpisodeThumbsBulk,
  resolveKitsuId, extractSeasonHint, enrichmentEnabled, tmdbEnabled, mapPool,
  EPISODE_TMDB_THRESHOLD,
} from "../core/enrich.js";
import {
  rememberAnime, rememberSlugTitle, lookupAnime, queueIdentityBackfill, identityStats,
} from "../core/identity.js";
import { mergeItem, mergeIdentityFields, crossSectionMerge } from "../core/merge.js";

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
// v2.5.0: ?slug= is accepted everywhere ?key= is — slugs are the ONE
// identifier that always resolves upstream, so they are a first-class
// query param, not just a valid key payload.
const keyOf = (req) => req.query.key || req.query.id || req.query.slug;

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

/**
 * v2.5.0 — subtitle track URLs through /api/proxy/subtitle.
 * Every track gets BOTH renditions: proxiedUrl (WebVTT — what browsers
 * want for <track>) and proxiedSrtUrl (SubRip — what players/download
 * pipelines want). The source format is preserved in the track object.
 */
function proxiedSubtitleUrl(sub, format = "vtt") {
  if (!sub?.url) return null;
  const enc = encodeURIComponent(sub.url);
  const ref = sub.referer ? `&ref=${encodeURIComponent(sub.referer)}` : "";
  return `/api/proxy/subtitle?url=${enc}${ref}&format=${format}`;
}

/** Enrich one upstream subtitle track with proxied renditions. */
function publicSubtitle(sub = {}) {
  if (!sub?.url) return null;
  const out = {
    label: sub.label || "Unknown",
    language: sub.language || "unknown",
    url: sub.url,
    format: sub.format || detectSubtitleFormat(sub.rawPreview || "") || null,
    default: Boolean(sub.default),
    proxiedUrl: proxiedSubtitleUrl(sub, "vtt"),   // WebVTT (native <track>)
    proxiedSrtUrl: proxiedSubtitleUrl(sub, "srt"), // SubRip (players/downloads)
  };
  return out;
}

/** Enrich a stream's subtitle list; returns [] when nothing usable. */
function publicSubtitles(subs) {
  return (Array.isArray(subs) ? subs : []).map(publicSubtitle).filter(Boolean);
}

/**
 * v2.5.0 — upstream Referer the proxies fetch with.
 * The megaplay CDN family (anipixcdn/nexabloom/qeltrix/zhaevor/quavex…)
 * answers 403 to requests without their player Referer. The proxy
 * handlers therefore default to the player origin and only send NO
 * Referer when the caller explicitly passes ref=none.
 */
function upstreamReferer(ref) {
  if (ref === undefined || ref === null || ref === "") return STREAM_REFERER; // Referer-default
  if (String(ref).toLowerCase() === "none") return null;                       // explicit opt-out
  return String(ref);
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
  // v2.5.0: subtitle tracks now carry same-origin proxiedUrl (VTT) +
  // proxiedSrtUrl (SRT) so browsers AND player pipelines are covered.
  const subs = publicSubtitles(s.subtitles);
  if (subs.length) out.subtitles = subs;
  if (s.skipIntro) out.skipIntro = s.skipIntro;
  return out;
}

/** Public anime RESOURCE — built exclusively by core/shape.js.
 *  v2.4.0: `identitySlug` (the listing slug the request resolved from)
 *  wins over the title-derived slug, and the shared identity index can
 *  supply the best-known listing slug for id-keyed requests — so the
 *  detail surfaces agree with the browse rows that carry the same anime. */
function publicAnime(canonicalEntry, extra = {}, identitySlug = "") {
  if (!canonicalEntry || typeof canonicalEntry !== "object") return { ...(extra || {}) };
  const known = lookupAnime({
    anilistId: canonicalEntry.anilistId ?? null,
    malId: canonicalEntry.malId ?? null,
    slug: identitySlug || canonicalEntry.slug || "",
  });
  const slug = identitySlug || known?.listingSlug || known?.slug || "";
  return canonicalAnime({
    canonical: canonicalEntry,
    identity: slug ? { slug } : null,
    extra: extra && Object.keys(extra).length ? extra : null,
  });
}

/**
 * v2.5.0 — THE FLEXIBLE IDENTITY BLOCK.
 * Every detail response carries every address the system knows for the
 * anime, so clients can silently switch identifier schemes when one form
 * is not indexed upstream: SLUG keys always resolve (the upstream catalog
 * understands its own slugs), anilist/mal ids are the indexed fallbacks —
 * and vice versa. `preferred` is the recommended key to feed OTHER
 * endpoints (slug when known, canonical id key otherwise); `keys`
 * exposes each scheme explicitly so no client has to guess.
 */
function identityBlock({ anilistId = null, malId = null, slug = "", canonical = null } = {}) {
  const bestSlug = slug || canonical?.slug || "";
  const keys = {
    ...(bestSlug ? { slug: bestSlug } : {}),
    ...(anilistId ? { anilist: `anilist:${anilistId}` } : {}),
    ...(malId ? { mal: `mal:${malId}` } : {}),
  };
  return {
    preferred: bestSlug || keys.anilist || keys.mal || null,
    slug: bestSlug || null,
    anilistId: anilistId ?? canonical?.anilistId ?? null,
    malId: malId ?? canonical?.malId ?? null,
    keys,
  };
}

/** The most resilient key for follow-up endpoint calls: slug first. */
function preferredKey({ anilistId, malId, slug, canonical }) {
  const block = identityBlock({ anilistId, malId, slug, canonical });
  return block.preferred || keyForIds({ anilistId, malId, slug }) || "";
}

/**
 * v2.4.0 — THE COMPLETENESS PASS for one shaped item.
 * Whatever ANY sibling endpoint of this process already resolved about this
 * anime (ids, year, status, type, episodes, genres, synonyms, titles) is
 * filled in from the shared identity index — the data exists in the system,
 * it was just not shared before. Missing keys stay null (never invented);
 * unknown rows additionally feed the background backfill queue so the NEXT
 * request carries the complete shape.
 */
function applyIdentityIndex(item = {}) {
  if (!item || typeof item !== "object") return item;
  const needsIds = item.anilistId == null || item.malId == null;
  const needsMeta = !item.year || !item.status || !item.type ||
    !Array.isArray(item.genres) || item.genres.length === 0 ||
    !Array.isArray(item.synonyms) || item.synonyms.length === 0 ||
    !item.titleEnglish || item.episodes == null;
  const rec = lookupAnime({ slug: item.slug, title: item.title });
  if (rec) {
    // keep this slug↔title pair resolvable (stale slugs stay addresses)
    if (item.slug && (rec.title || item.title)) rememberSlugTitle(item.slug, rec.title || item.title);
    if (item.anilistId == null && rec.anilistId != null) item.anilistId = rec.anilistId;
    if (item.malId == null && rec.malId != null) item.malId = rec.malId;
    if (!item.year && rec.year != null) item.year = rec.year;
    if (!item.status && rec.status) item.status = rec.status;
    if (!item.type && rec.format) item.type = rec.format;
    if (item.episodes == null && rec.episodes != null) item.episodes = rec.episodes;
    if (Array.isArray(rec.genres) && rec.genres.length && (!Array.isArray(item.genres) || item.genres.length === 0)) item.genres = rec.genres;
    if (Array.isArray(rec.synonyms) && rec.synonyms.length && (!Array.isArray(item.synonyms) || item.synonyms.length === 0)) item.synonyms = rec.synonyms;
    if (!item.titleEnglish && rec.titleEnglish) item.titleEnglish = rec.titleEnglish;
    if (!item.titleNative && rec.titleNative) item.titleNative = rec.titleNative;
    if (!item.titleRomaji && rec.titleRomaji) item.titleRomaji = rec.titleRomaji;
    if (!item.poster && rec.poster) { item.poster = rec.poster; if (item.artSource === null) item.artSource = "upstream"; }
    if (item.anilistId || item.malId) {
      item.key = keyForIds({ anilistId: item.anilistId, malId: item.malId, slug: item.slug });
    }
    // known slug↔title but NO ids anywhere yet — background-anchor it so the
    // NEXT request carries the complete shape (never blocks this response)
    if (item.anilistId == null && rec.anilistId == null && (item.title || item.slug)) {
      queueIdentityBackfill({ slug: item.slug, title: rec.title || item.title });
    }
  } else if (needsIds && (item.title || item.slug)) {
    // unknown to the index — background-anchor it (never blocks this response)
    queueIdentityBackfill({ slug: item.slug, title: item.title });
    rememberSlugTitle(item.slug, item.title);
  }
  return item;
}

/** `?art=0` — documented escape hatch to skip provider enrichment. */
const skipArt = (req) => req.query.art === "0" || !enrichmentEnabled();

/**
 * Enforce the null policy on a flat list item: string fields are "",
 * array fields are [], identifier/number fields stay null when unknown,
 * art fields (poster/cover/artSource/…) are null when no source has art.
 * Field sets below are THE public list-item contract.
 */
const ITEM_STR = ["key", "slug", "title", "titleRomaji", "titleEnglish", "titleNative", "type", "status", "season", "rating", "airingTime"];
const ITEM_ARR = ["synonyms", "genres", "studios", "externalLinks"];
const ITEM_NULLABLE = ["anilistId", "malId", "year", "episodes", "score", "duration", "averageScore", "meanScore", "popularity", "favourites", "airingAt", "airingEpisode"];
const ITEM_ART_NULLABLE = ["poster", "cover", "artSource", "backdrop", "logo", "banner", "trailer"];
const ITEM_DESCRIPTION = ["description"];
const ITEM_OBJ = ["nextAiringEpisode"];  // v2.6.0 — airing countdown; merge layer fills

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
  // v2.6.0 — object fields (nextAiringEpisode). Pass through when the
  // merge layer filled it; otherwise emit null so the key is present
  // consistently across every row (clients can rely on the field
  // existing even when its value is null).
  for (const f of ITEM_OBJ) {
    const v = item[f];
    out[f] = (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
  }
  // strip the internal `_complete` flag — merge-layer hint, never emitted
  if (out._complete !== undefined) delete out._complete;
  // extensions ride along after the core fields, same names everywhere
  for (const [k, v] of Object.entries(item)) {
    if (ITEM_STR.includes(k) || ITEM_ARR.includes(k) || ITEM_NULLABLE.includes(k) ||
        ITEM_ART_NULLABLE.includes(k) || ITEM_DESCRIPTION.includes(k) || ITEM_OBJ.includes(k) || k === "_complete") continue;
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
  // v2.4.0: every observed slug↔title pair keeps /api/resolve working for
  // entries any endpoint returned (including stale upstream slugs)
  rememberSlugTitle(rawSlug, title);
  // v2.6.1 — REUSE OF DATA THE EXTRACTORS ALREADY SCRAPED.
  // The kaze extractors each pull a different field subset from the
  // same upstream anime (spotlight: description+rating+quality+
  // releaseDate; trending: total+sub+dub+type; upcoming: releaseDate;
  // etc.). rememberAnime() accumulates ALL of them by slug — never
  // downgrades, never overwrites a non-empty with an empty — so the
  // NEXT endpoint that touches this slug carries the UNION of fields
  // every extractor has ever scraped. No AniList, no external
  // fetching, pure reuse of data already in the system.
  if (rawSlug && (title || raw.anilistId || raw.malId)) {
    rememberAnime({
      slug: rawSlug,
      title,
      anilistId: raw.anilistId,
      malId: raw.malId,
      // upstream-scraped fields the extractor pulled
      description: raw.description || raw.synopsis,
      rating: raw.rating,
      quality: raw.quality,
      releaseDate: raw.releaseDate || raw.date,
      sub: raw.sub,
      dub: raw.dub,
      total: raw.total,
      episodes: raw.total ?? raw.episodes,
      type: raw.type,
      status: raw.status,
      year: raw.year,
      poster: raw.poster,
      airingTime: raw.airingTime || raw.time,
      airingAt: raw.airingAt,
      airingEpisode: raw.airingEpisode ?? raw.episode_no,
      titleRomaji: raw.japaneseTitle || raw.titleAlt || raw.titleRomaji,
      genres: Array.isArray(raw.genres) ? raw.genres : undefined,
      synonyms: Array.isArray(raw.synonyms) ? raw.synonyms : undefined,
    });
  }
  // Upstream sidebar/list items sometimes carry their own NUMERIC ids in the
  // slug position ("7457", "1642"). A bare number in `slug`/`key` would
  // collide with the numeric-AniList-id key format and resolve to the WRONG
  // anime — so numeric-only slugs fall back to the title-derived slug and the
  // raw id is preserved as the `animeId` extension instead.
  const numericUpstreamId = /^\d+$/.test(rawSlug) ? rawSlug : null;
  const slug = numericUpstreamId ? titleSlug(title) : rawSlug || titleSlug(title);
  // v2.4.0: consult the shared identity index BEFORE shaping — rows inherit
  // the ids/metadata other endpoints already resolved for this anime
  const known = lookupAnime({ slug, title }) || {};
  // ishi-lane rows carry real AniList/MAL ids; kaze catalog rows do not —
  // take what the row actually has, never invent. The index may know more.
  const item = animeListItem({
    identity: {
      anilistId: raw.anilistId ?? known.anilistId ?? null,
      malId: raw.malId ?? known.malId ?? null,
      slug,
      title,
    },
    extra: {
      titleRomaji: raw.japaneseTitle || raw.titleAlt || raw.titleRomaji || known.titleRomaji || "",
      titleEnglish: raw.titleEnglish || known.titleEnglish || "",
      titleNative: raw.titleNative || known.titleNative || "",
      // NOTE: upstream `japaneseTitle` is the ROMAJI alt title (verified
      // live: "Mushoku Tensei III: Isekai Ittara Honki Dasu") — it feeds
      // titleRomaji only. titleNative is never fabricated from it (v2.3.0
      // fix: it used to pollute titleNative with romaji on every row).
      poster: raw.poster || known.poster || "",
      cover: raw.cover || "",
      type: raw.type || known.format || "",
      status: raw.status || known.status || "",
      season: raw.season || "",
      year: raw.year ?? known.year ?? null,
      episodes: raw.total ?? raw.episodes ?? known.episodes ?? null,
      score: raw.score ?? null,
      rating: raw.rating || "",
      description: raw.description || raw.synopsis || "",
      synonyms: known.synonyms || [],
      genres: (Array.isArray(raw.genres) && raw.genres.length) ? raw.genres : (known.genres || []),
      artSource: (raw.poster || raw.cover || known.poster) ? "upstream" : null,
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
  if (raw.airingTime) item.airingTime = raw.airingTime;    // v2.6.0 — direct from extractor
  if (raw.airingAt != null) item.airingAt = raw.airingAt;  // v2.6.0 — unix seconds countdown
  if (raw.episode_no !== undefined && raw.episode_no !== null) item.airingEpisode = Number(raw.episode_no) || null;
  if (raw.airingEpisode !== undefined && raw.airingEpisode !== null) item.airingEpisode = Number(raw.airingEpisode) || item.airingEpisode || null;
  if (raw.url) item.url = raw.url;
  return finalizeItem(applyIdentityIndex(item));
}

// ================================================================ CORE
/**
 * v2.5.1 — the ONE search pipeline both /api/search and /api/suggestions
 * run through. Identical groups, identical shapes, identical ids, one
 * shared upstream cache — the two endpoints can no longer disagree.
 */
async function runSearchPipeline(q, req) {
  const data = await unifiedSearch(q, page(req));
  let results = data.groups
    .map(({ lanes, _first, ...pub }) => finalizeItem(pub))
    // unanchored groups may duplicate an anchored one by slug — keep first only
    .filter((r, i, arr2) => !r.slug || arr2.findIndex((x) => x.slug && x.slug === r.slug) === i);
  // v2.3.0: same art contract as every other listing surface
  await enrichItemList(results, { skipArt: skipArt(req) });
  return { results, page: data.page };
}

/**
 * GET /api/search?q=naruto [&page=1]
 * One deduplicated list — romaji/English duplicates are merged silently.
 * Every result carries the unified identity block (key/slug/ids/titles)
 * so any returned entry can be fed straight into any other endpoint.
 */
router.get("/search", wrap(async (req, res) => {
  const q = req.query.q || req.query.keyword || req.query.query;
  if (!q) throw new CustomError("Missing ?q= (search term)", 400);
  const { results, page: p } = await runSearchPipeline(q, req);
  res.json({ success: true, api: "APIKuoshi", query: q, page: p, count: results.length, results });
}));

/**
 * GET /api/suggestions?keyword=one [&page=1] [&limit=10]
 * v2.5.1: SAME PIPELINE as /api/search — the response now carries the very
 * same results array for the same term (same items, same ids, same order),
 * under BOTH `suggestions` (the typeahead key) and `results` (the /api/search
 * parity key). Previously this endpoint hit the lightweight kaze typeahead
 * lane alone, so its rows could disagree with /api/search in count, title
 * spellings and even AniList ids. `?limit=` trims the tail for typeahead
 * UIs; without it the full search result set is returned.
 */
router.get("/suggestions", wrap(async (req, res) => {
  const keyword = req.query.keyword || req.query.q || req.query.query;
  if (!keyword) throw new CustomError("Missing ?keyword= (search term)", 400);
  const { results, page: p } = await runSearchPipeline(keyword, req);
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  const suggestions = limit > 0 ? results.slice(0, limit) : results;
  res.json({
    success: true, api: "APIKuoshi",
    query: keyword, keyword, page: p,
    count: suggestions.length,
    suggestions,
    results: suggestions,
  });
}));

/**
 * GET /api/resolve?title=frieren [&advanced=1]
 * Turn ANY identity into the canonical key + confirm playability.
 * v2.5.1: the value may arrive under ANY of ?title= ?q= ?key= ?query=
 * ?keyword= ?slug= ?anilist= ?mal= ?id= ?url= ?anime= ?name=, and the key
 * itself may be: anilist:<id> | mal:<id> | slug:<slug> | <numeric id> |
 * <slug> | <title> (romaji / english / native / synonym) | a pasted URL
 * (anilist.co/anime/<id>, myanimelist.net/anime/<id>, watch-site
 * /watch/<slug> — the id or slug is extracted automatically).
 *
 * v2.6.0 — `?advanced=1` climbs the LONGER identity ladder:
 * reverse-MAL lookup (getSiteIdsByMal), kaze.search(title) fallback,
 * multi-variant title search (romaji/english/native/synonyms), and
 * background-backfill enqueue on miss. Use it for keys that the
 * foreground canonicalFor gave up on (404/502). The NEXT request
 * after a backfill will resolve through canonicalFor directly.
 */
router.get("/resolve", wrap(async (req, res) => {
  const q = req.query;
  // v2.5.1: any param name carries the value; scheme-named params (?anilist=
  // ?mal=) pin the scheme onto bare numbers so "50265" under ?mal= is read
  // as mal:50265, not as a bare AniList id.
  const bare = (v, scheme) =>
    /^\d+$/.test(String(v || "")) ? `${scheme}:${v}` : v;
  const title = q.title || q.q || q.key || q.query || q.keyword ||
    (q.slug ? (String(q.slug).includes(" ") ? q.slug : `slug:${q.slug}`) : null) ||
    (q.anilist ? bare(q.anilist, "anilist") : null) ||
    (q.mal ? bare(q.mal, "mal") : null) ||
    q.id || q.url || q.anime || q.name;
  if (!title) throw new CustomError("Missing ?title= (any key: slug | anilist | mal | id | url | title)", 400);

  // v2.6.0 — ?advanced=1 / ?deep=1 → climb the longer ladder.
  const advanced = q.advanced === "1" || q.deep === "1" || q.advanced === "true";
  const { anilistId, malId, slug, canonical, via } = await resolveFlexible(title, { advanced });
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
    via: via || null,   // v2.6.0 — tells the client WHICH ladder step resolved the key
    advanced,            // v2.6.0 — reflects whether the advanced ladder was climbed
    // v2.4.0: the slug the request arrived by wins — resolving a browse
    // entry returns THAT entry's address, not a divergent title-derived one
    anime: publicAnime(canonical, null, slug),
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
  const { anilistId, malId, slug, canonical } = await resolveFlexible(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });
  // v2.5.0: endpoint map keys are SLUG-first — slugs always resolve
  // upstream, id keys are the indexed fallback.
  const enc = encodeURIComponent(preferredKey({ anilistId, malId, slug, canonical }));

  // v2.7.0 — Hello World slug-collision guard.
  // The upstream kaze catalog has known slug-collision bugs where the same
  // listing slug maps to two different anime (e.g. "hello-world-isbqw"
  // returns anilist:206275 "Wo Zai Feitu Shijie Sao Laji" instead of
  // HELLO WORLD anilist:106240). When the user explicitly passes
  // anilist:<id>, we verify the resolved canonical entry's anilistId
  // actually matches — if not, we fetch the correct AniList entry directly.
  let effectiveAnilistId = anilistId;
  let effectiveCanonical = canonical;
  if (/^anilist:\d+$/i.test(String(key || "").trim())) {
    const requestedId = parseInt(String(key).split(":")[1], 10);
    if (requestedId && requestedId !== anilistId) {
      const alEntry = await anilistById(requestedId).catch(() => null);
      if (alEntry) {
        effectiveAnilistId = requestedId;
        effectiveCanonical = alEntry;
      }
    }
  }

  // v2.3.0: top-up the canonical entry with AniList's rich detail
  // (synopsis/genres/score/season) so /api/anime and /api/meta carry the
  // SAME depth for the same key — the by-id canonical lookup intentionally
  // stays lean, the detail query fills the rest (6 h cache).
  const detailTopUp = effectiveAnilistId ? await anilistDetail(effectiveAnilistId).catch(() => null) : null;
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
  const relationsRaw = effectiveAnilistId ? await anilistRelations(effectiveAnilistId).catch(() => []) : [];
  const relations = relationsBlock(
    (relationsRaw || []).map((r) => ({
      ...animeListItem({ canonical: r, identity: { slug: r.slug || "" } }),
      relation: r.relationType || "related",
    })).map(finalizeItem)
  );

  const anime = publicAnime(effectiveCanonical, extra, slug);
  // v2.6.0 — merge layer top-up: pulls nextAiringEpisode (countdown!),
  // duration, averageScore, studios, trailer, banner, synonyms, etc.
  // from anilistDetail (cached 24h) when canonical doesn't carry them.
  await mergeItem(anime, {});
  // v2.3.0: full art chain on the detail resource — poster/cover/backdrop/
  // banner/logo. enrichAnimeArt keeps the AniList banner when present and
  // only falls back to the TMDB backdrop when it is missing.
  const art = await enrichAnimeArt(anime, { detail: true, skipArt: skipArt(req) });
  Object.assign(anime, art);

  res.json({
    success: true,
    api: "APIKuoshi",
    key: effectiveAnilistId ? `anilist:${effectiveAnilistId}` : canonicalKey,
    // v2.5.0: every address of this anime in one block — switch schemes
    // silently when one lane is not indexed (slug ↔ anilist ↔ mal).
    identities: identityBlock({ anilistId: effectiveAnilistId, malId, slug, canonical: effectiveCanonical }),
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
 *
 * v2.7.1 — PERFORMANCE (was: One Piece timed out at 1100+ episodes):
 *   • Bulk Kitsu fetch. The old per-episode `mapPool` loop fired ONE
 *     Kitsu HTTP request per episode (≈1100 req for One Piece). It is
 *     replaced by `enrichEpisodeThumbsBulk`, which fetches the WHOLE
 *     Kitsu episode index in one bounded-parallel paginated walk and
 *     folds each episode in-memory — zero per-episode HTTP on the
 *     Kitsu side.
 *   • TMDB threshold. Per-episode TMDB calls (no bulk endpoint exists)
 *     are auto-skipped when `count > EPISODE_TMDB_THRESHOLD` (default
 *     50). The response reports `enrichment.tmdbSkipped: true` when so.
 *     `?withThumbs=1` opts back into full per-episode TMDB enrichment.
 *   • Pagination. `?page=1&perPage=50` returns a single page plus a
 *     ready-to-use `pagination.next` URL. Default returns ALL episodes
 *     (back-compat with pre-2.7.1 clients).
 *   • Cache key bumped to `:v6` so stale entries from the per-episode
 *     path don't ship placeholder thumbnails.
 */
router.get("/anime/episodes", wrap(async (req, res) => {
  const key = keyOf(req);
  const { anilistId, malId, slug, canonical } = await resolveFlexible(key);
  const canonicalKey = keyForIds({ anilistId, malId, slug });

  const episodes = await withCache(`episodes:${anilistId ?? slug ?? malId}:v6`, config.cacheSeconds, async () => {
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

  // v2.7.1: BULK enrichment — one Kitsu walk for the whole list, plus
  // per-episode TMDB gated by EPISODE_TMDB_THRESHOLD. `?withThumbs=1`
  // forces per-episode TMDB even on long shows (One Piece, Conan, …).
  // `?art=0` (existing) short-circuits to series-poster fallback.
  const seriesTitle = canonical?.titleRomaji || canonical?.title || "";
  const seasonHint = seriesTitle ? extractSeasonHint(seriesTitle).season : null;
  const forceThumbs = req.query.withThumbs === "1" || req.query.thumbs === "1";
  const coverage = await enrichEpisodeThumbsBulk(shaped, {
    seriesTitle,
    seasonHint,
    seriesPoster,
    skipArt: skipArt(req),
    forceTmdb: forceThumbs,
  });

  // ---- v2.7.1: server-side pagination ----------------------------------
  // Default: return the whole list (back-compat). When `perPage` is
  // present, return one page plus a ready-to-use `pagination.next` URL.
  const perPageRaw = parseInt(req.query.perPage, 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0
    ? Math.min(perPageRaw, 200)
    : 0; // 0 = no pagination
  const pageNum = Math.max(parseInt(req.query.page, 10) || 1, 1);

  let pagedShaped = shaped;
  let pagination = null;
  if (perPage > 0) {
    const total = shaped.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(pageNum, totalPages);
    const startIdx = (safePage - 1) * perPage;
    pagedShaped = shaped.slice(startIdx, startIdx + perPage);
    const nextPath = safePage < totalPages
      ? `/api/anime/episodes?key=${encodeURIComponent(canonicalKey)}&perPage=${perPage}&page=${safePage + 1}`
      : null;
    pagination = {
      page: safePage,
      perPage,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      next: nextPath,
    };
  }

  res.json({
    success: true,
    api: "APIKuoshi",
    key: canonicalKey,
    identities: identityBlock({ anilistId, malId, slug, canonical }),
    poster: seriesPoster || null,
    count: pagedShaped.length,
    totalEpisodes: shaped.length,
    enrichment: {
      tmdb: tmdbEnabled(),
      coverage,
      tmdbThreshold: EPISODE_TMDB_THRESHOLD,
      withThumbs: forceThumbs,
    },
    ...(pagination ? { pagination } : {}),
    episodes: pagedShaped,
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
  const { anilistId, malId, slug, canonical } = await resolveFlexible(key);
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

  res.json({ success: true, api: "APIKuoshi", key: canonicalKey, identities: identityBlock({ anilistId, malId, slug, canonical }), poster: canonical?.poster || "", episode: ep, count: servers.length, servers });
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
  const { anilistId, malId, slug, canonical } = await resolveFlexible(key);
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
    // v2.5.0: flexible identity block + slug-preferred playback keys.
    identities: identityBlock({ anilistId, malId, slug, canonical }),
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
  const { anilistId, malId, slug, canonical } = await resolveFlexible(key);

  const kaze = getLane("kaze");
  const match = await matchSlug(kaze, canonical, slug);
  if (!match) throw new CustomError(`No download links available for episode ${ep}`, 404);
  const data = await kaze.download(match.listingId, ep);
  const downloads = Array.isArray(data) ? data : data?.downloads ?? [];
  if (!downloads.length) throw new CustomError(`No download links available for episode ${ep}`, 404);

  res.json({ success: true, api: "APIKuoshi", key: keyForIds({ anilistId, malId, slug }), identities: identityBlock({ anilistId, malId, slug, canonical }), episode: ep, count: downloads.length, downloads });
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
    // v2.6.0 — POST-SHAPE MERGE LAYER: fills every empty field
    // (anilistId/malId/year/season/episodes/score/genres/synonyms/
    // titles/nextAiringEpisode) from the shared identity index +
    // AniList detail cache. The shape layer built the canonical
    // row; the merge layer FILLS it from the rest of the system.
    // The data exists; it was just not shared before.
    await mergeIdentityFields(results, { skipAnilist: artOff && req?.query?.merge !== "1" ? false : false });
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
    // v2.6.0 — CROSS-SECTION MERGE for home/top-ten/trending-sidebar:
    // the same slug appears in multiple sections with different field
    // richness (spotlights has description+rating, trending has total,
    // topAiring has neither). Merge them so the row in EVERY section
    // carries the UNION of fields, not the WORST set. Only runs when
    // there are 2+ section arrays — single-section payloads skip.
    if (animeArrays.length >= 2) {
      const merged = crossSectionMerge(animeArrays.flat());
      // Re-distribute merged rows back into each section so the
      // response shape (sectioned) is preserved; each section now
      // points to the SAME enriched row object for shared slugs.
      const byId = new Map(merged.map(r => {
        const id = r.slug || r.key || (r.anilistId ? "a:" + r.anilistId : null) || (r.malId ? "m:" + r.malId : null) || Symbol();
        return [id, r];
      }));
      for (const arr of animeArrays) {
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i].slug || arr[i].key || (arr[i].anilistId ? "a:" + arr[i].anilistId : null) || (arr[i].malId ? "m:" + arr[i].malId : null);
          if (id && byId.has(id)) arr[i] = byId.get(id);
        }
      }
    }
    // v2.6.0 — POST-SHAPE MERGE LAYER on object-shaped payloads too.
    // Runs on the flattened union so a single AniList call fills all
    // duplicates at once (the index + cache make subsequent calls
    // for the same anime free).
    if (animeArrays.length) {
      await mergeIdentityFields(animeArrays.flat(), {});
    }
    // v2.3.0: single-anime payloads (random) get the SAME canonical shape
    // as every list item — they used to leak the raw extractor object.
    if (!animeArrays.length && looksLikeAnimeRow(data)) {
      data = catalogListItem(data);
      singleAnime = true;
      // v2.6.0 — single-anime rows also get the merge layer (they
      // go through the same code path as every list item now).
      await mergeItem(data, {});
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

/**
 * v2.4.0 — BROWSE TTL CACHE.
 * Browse/catalog pages are upstream scrapes that change on the scale of
 * minutes/hours, yet v2.3 re-fetched them on EVERY request (upcoming took
 * ~7 s cold). A short unified-layer TTL keeps repeat hits instant while
 * staying fresh; keys are canonical (lower-cased, param-order independent)
 * so ?sort=week&page=2 and ?page=2&sort=week share one entry.
 * /api/random is never cached (randomness is the contract).
 */
const BROWSE_TTL_SECONDS = Math.max(parseInt(process.env.BROWSE_CACHE_SECONDS, 10) || 120, 0);

function canonicalQueryKey(req, extraKeys = []) {
  const params = Object.entries(req.query)
    .filter(([k]) => !ignoredForCache.has(k))
    .map(([k, v]) => `${k.toLowerCase()}=${String(v).toLowerCase()}`)
    .sort();
  return [...extraKeys, ...params].join("|");
}
const ignoredForCache = new Set(["art"]); // art toggles skip providers, not data

const NO_CACHE_LABELS = new Set(["random"]);

async function cachedBrowse(req, label, fetcher) {
  if (!BROWSE_TTL_SECONDS || NO_CACHE_LABELS.has(label)) return fetcher();
  const key = `browse:${label}:${canonicalQueryKey(req)}`;
  return withCache(key, BROWSE_TTL_SECONDS, fetcher);
}

const browseList = (kazeFn, { ishiFallback = null, label } = {}) =>
  wrap(async (req, res) => {
    const result = await cachedBrowse(req, label, () =>
      withFallback(
        async (lane) => {
          if (lane.id === "kaze") {
            const out = await kazeFn(lane, req);
            return out || null;
          }
          if (lane.id === "ishi" && ishiFallback) return ishiFallback(lane, req);
          return null;
        },
        { label }
      )
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

router.get("/schedule", browseList((kaze, req) => {
  // v2.6.0 — accept ?date=YYYY-MM-DD (default = today's UTC date)
  const qd = String(req.query.date || req.query.d || "").trim();
  const dateMatch = qd.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return kaze.schedule(dateMatch ? qd : null);
}, { label: "schedule" }));

/**
 * GET /api/airing [&page=] [&countdown=1]
 * Currently airing anime. v2.6.0 — the ishi lane now pulls
 * nextAiringEpisode (countdown) straight from the AniList
 * season-now query; the kaze fallback also carries airingAt.
 */
router.get("/airing", wrap(async (req, res) => {
  const result = await cachedBrowse(req, "airing", () =>
    withFallback(
      async (lane) => {
        if (lane.id === "ishi") return { data: await lane.airing() };
        if (lane.id === "kaze") return lane.schedule();
        return null;
      },
      { label: "airing" }
    )
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
 * v2.4.0 — THE RELATION SET for /api/seasons and /api/watch-order.
 *
 * Source of truth: the AniList relations graph (typed edges — prequel/
 * sequel/side story/spin-off/…), reached through the shared identity
 * resolver. Same franchise BY CONSTRUCTION: every edge is the source's own
 * statement about the pair, so cross-franchise false positives are
 * impossible. Each entry follows the canonical list-item shape with its
 * slug preserved and its relation normalized into the shared buckets.
 *
 * Fallback (no AniList identity / graph empty): the kaze watch-page
 * sidebar, STRICTLY filtered to same-franchise entries (shared title root
 * or shared slug root) and labelled with the relation the page itself
 * prints. Whatever the sidebar throws in that is not the franchise —
 * the v2.3 bug where unrelated seasons, wrong sequels/prequels and stray
 * specials leaked in — is dropped, never returned.
 */
const FRANCHISE_STOPWORDS = new Set([
  "the", "and", "part", "season", "tv", "episode", "special", "movie",
  "ova", "ona", "complete", "edition", "final", "new", "ii", "iii", "iv",
]);

function franchiseTokens(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !FRANCHISE_STOPWORDS.has(t) && !/^[0-9]+$/.test(t));
}

function sameFranchise(aTitle = "", bTitle = "", aSlug = "", bSlug = "") {
  const at = franchiseTokens(aTitle);
  const bt = franchiseTokens(bTitle);
  if (at.length && bt.length) {
    if (at.some((t) => bt.includes(t))) return true;
  }
  // slug-root comparison ("steins-gate-0-xyz" vs "steins-gate-abc")
  const as = String(aSlug || "").toLowerCase().split("-").filter((t) => t.length > 2 && !FRANCHISE_STOPWORDS.has(t));
  const bs = String(bSlug || "").toLowerCase().split("-").filter((t) => t.length > 2 && !FRANCHISE_STOPWORDS.has(t));
  return Boolean(as.length && bs.length && as.some((t) => bs.includes(t)));
}

async function relationSetFor(req, slugParam) {
  const { anilistId, malId, slug, canonical } = await resolveFlexible(slugParam);
  const canonicalKey = keyForIds({ anilistId, malId, slug });
  const selfTitle = canonical?.titleRomaji || canonical?.title || "";
  const selfSlug = slug || canonical?.slug || "";

  let entries = [];
  let root = null;
  let source = "none";

  // v2.5.2: skip the transitive franchise walk with ?deep=0 (callers that
  // want the v2.5.1 behaviour — only AniList's direct relations of the
  // queried entry — can opt out). Default: walk the whole franchise.
  const deep = (req?.query?.deep ?? "1") !== "0";

  // 1. AniList franchise — TRANSITIVE walk of the relations graph.
  //    Direct anilistRelations() only returns the queried entry's own
  //    edges, so any sequel/season-N caller got a truncated franchise
  //    (the parent show, stored on the predecessor's record, was
  //    missing). anilistFranchise walks BFS up to depth 3 and infers
  //    each node's relation to ROOT, so the FULL franchise (every
  //    season, OVA, movie, side-story) comes back regardless of which
  //    entry the caller keyed on.
  if (anilistId) {
    if (deep) {
      const fr = await anilistFranchise(anilistId).catch(() => null);
      root = fr?.root || null;
      const frEntries = (fr?.entries || []).filter(Boolean);
      entries = frEntries.map((r) => finalizeItem({
        ...animeListItem({ canonical: r, identity: { slug: r.slug || "" } }),
        relation: bucketForRelation(r.relationType, r.format),
        franchiseHops: Number.isFinite(r.franchiseHops) ? r.franchiseHops : null,
      }));
      if (entries.length) source = "anilist-franchise";
    } else {
      const relRaw = await anilistRelations(anilistId).catch(() => []);
      entries = (relRaw || []).map((r) => finalizeItem({
        ...animeListItem({ canonical: r, identity: { slug: r.slug || "" } }),
        relation: bucketForRelation(r.relationType, r.format),
      }));
      if (entries.length) source = "anilist-relations";
    }
  }

  // 2. kaze sidebar fallback — franchise-validated, relation-labelled
  if (!entries.length) {
    let raw = null;
    let usedSlug = null;
    let lastErr = null;
    const kaze = getLane("kaze");
    let candidates = [];
    try { candidates = await listingSlugsFor(slugParam); } catch { candidates = slug ? [slug] : []; }
    for (const candidate of candidates) {
      try {
        raw = await kaze.seasons(candidate);
        const list = raw?.data?.seasons ?? raw?.seasons;
        if (Array.isArray(list) && list.length) { usedSlug = candidate; break; }
        if (!usedSlug) usedSlug = candidate;
        raw = null;
      } catch (err) { lastErr = err; }
    }
    if (!raw) {
      // watch-order variant of the same sidebar
      for (const candidate of candidates) {
        try {
          raw = await kaze.watchOrder(candidate);
          const list = raw?.data?.related ?? raw?.related;
          if (Array.isArray(list) && list.length) { usedSlug = candidate; break; }
          if (!usedSlug) usedSlug = candidate;
          raw = null;
        } catch (err) { lastErr = err; }
      }
    }
    const sidebarRaw = raw?.data?.seasons ?? raw?.data?.related ?? raw?.seasons ?? raw?.related;
    if (Array.isArray(sidebarRaw)) {
      entries = sidebarRaw
        .map(catalogListItem)
        .filter((e) => sameFranchise(e.title, selfTitle, e.slug, selfSlug))
        .map((e) => ({
          ...e,
          relation: normalizeRelation(e.relation || "related"),
        }));
      if (entries.length) source = "kaze-sidebar";
      else if (!anilistId && lastErr && !usedSlug) {
        throw new CustomError(`Relation data unavailable for "${slugParam}" (${lastErr.message})`, 502);
      }
    } else if (!anilistId && lastErr) {
      throw new CustomError(`Relation data unavailable for "${slugParam}" (${lastErr.message})`, 502);
    }
  }

  return { anilistId, malId, slug: selfSlug, canonicalKey, canonical, root, entries, source };
}

/**
 * v2.6.0 — RELATION FILTER PARSER for /api/seasons and /api/watch-order.
 * The user wanted: "remove relations like Related, Side story, music, etc
 * OR group them so client can easily choose if they want it included".
 * We do BOTH: the buckets stay in the response (grouped), but the
 * caller can opt OUT of any bucket via ?exclude=related,sideStory
 * (or opt IN to specific buckets via ?include=prequel,sequel,movie).
 *
 * Default exclude (when NEITHER ?exclude= nor ?include= is given):
 * "related" — the catch-all bucket that AniList's "OTHER" /
 * "CHARACTER" / untyped relations land in. Clients who DO want
 * the catch-all can pass ?include= (empty) or ?exclude= (empty).
 *
 * Returns: { include: Set|null, exclude: Set, defaulted: bool }
 */
function parseRelationFilter(req) {
  const q = req.query || {};
  const inc = q.include != null ? String(q.include) : null;
  const exc = q.exclude != null ? String(q.exclude) : null;
  if (inc != null) {
    const set = new Set(inc.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    return { include: set, exclude: new Set(), defaulted: false };
  }
  if (exc != null) {
    const set = new Set(exc.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    return { include: null, exclude: set, defaulted: false };
  }
  // default: exclude the "related" catch-all (clients opt back in
  // with ?exclude=, or ?include=related)
  return { include: null, exclude: new Set(["related"]), defaulted: true };
}

/** Apply the relation filter to a list of entries. Self (relation="self")
 * is ALWAYS kept — it's the queried anime itself. */
function applyRelationFilter(entries, filter) {
  if (!filter || (!filter.include && !filter.exclude.size)) return entries;
  const isSelf = e => (e?.relation || "").toLowerCase() === "self";
  return entries.filter(e => {
    if (isSelf(e)) return true;  // self always survives
    const rel = (e?.relation || "related").toLowerCase();
    if (filter.include) return filter.include.has(rel);
    return !filter.exclude.has(rel);
  });
}

/**
 * GET /api/seasons/:slug — the seasons/specials block for one anime.
 * :slug accepts any key format. v2.4.0: entries are TRUE relations only
 * (AniList relations graph first, franchise-validated sidebar fallback),
 * grouped by the canonical buckets prequel/sequel/sideStory/alternative/
 * spinoff/special/ova/ona/movie/summary/parent (+ related), every entry
 * in the canonical list-item shape with its slug preserved.
 *
 * v2.5.2: the AniList path now walks the franchise TRANSITIVELY, so the
 * seasons list contains every season of the franchise — not only the
 * direct neighbors of the queried entry (which was incomplete when the
 * caller keyed on a sequel/season-N). ?deep=0 keeps the v2.5.1 behaviour.
 *
 * v2.6.0: ?exclude=related,sideStory drops buckets the caller doesn't
 * want; ?include=prequel,sequel keeps ONLY those buckets. Default
 * excludes "related" (the catch-all). Self (relation="self") always
 * survives. The response's `groups` reflects the filtered set.
 */
router.get("/seasons/:slug", wrap(async (req, res) => {
  const { anilistId, malId, slug, canonicalKey, canonical, root, entries, source } =
    await relationSetFor(req, req.params.slug);

  // v2.3.0+: related entries are real resources — same art contract as
  // every other listing surface (slug always preserved, poster/cover filled).
  await enrichItemList(entries, { skipArt: skipArt(req) });

  // v2.6.0 — apply the relation filter (default exclude 'related')
  const filter = parseRelationFilter(req);
  const filtered = applyRelationFilter(entries, filter);
  const groups = relationsBlock(filtered).groups;

  // v2.5.2: expose the root entry (the queried anime itself) so clients
  // can know "which season am I on" without re-fetching /api/anime. NULL
  // when the franchise walk was skipped or unavailable.
  const rootItem = root ? finalizeItem({
    ...animeListItem({ canonical: root, identity: { slug: root.slug || slug || "" } }),
    relation: "self",
    franchiseHops: 0,
  }) : null;

  res.json({
    success: true,
    api: "APIKuoshi",
    kind: "seasons",
    key: canonicalKey,
    slug: slug || canonical?.slug || "",
    source,
    root: rootItem,
    filter: {                                              // v2.6.0
      include: filter.include ? [...filter.include] : null,
      exclude: [...filter.exclude],
      defaulted: filter.defaulted,
    },
    totalSeasons: filtered.length,
    count: filtered.length,
    seasons: filtered,
    groups,
    data: { slug: slug || canonical?.slug || "", totalSeasons: filtered.length, seasons: filtered },
  });
}));

/**
 * v2.5.2 — sort the franchise by release year (ascending; ties broken by
 * AniList id so the order is stable). This is the canonical "watch order"
 * most viewers expect: S1 (oldest) first, follow-ups after. Entries with
 * no year are placed LAST (they're usually upcoming/undated specials).
 */
function sortByReleaseYear(entries) {
  const withYear = entries.filter((e) => Number.isFinite(e.year));
  const withoutYear = entries.filter((e) => !Number.isFinite(e.year));
  withYear.sort((a, b) => (a.year - b.year) || ((a.anilistId ?? 0) - (b.anilistId ?? 0)));
  withoutYear.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
  return [...withYear, ...withoutYear];
}

/**
 * GET /api/watch-order/:slug — the COMPLETE franchise in watch order.
 *
 * v2.5.2 — THE WATCH-ORDER FIX:
 * The previous behaviour fetched only AniList's DIRECT relations of the
 * queried entry. AniList stores edges on one side only — "Steins;Gate →
 * SEQUEL → SG0" lives on the SG record, NOT on the SG0 record — so a
 * call for the sequel (SG0) returned only SG0's own OVA + side-story,
 * missing the parent show SG entirely. The "watch order" therefore
 * collapsed to "the immediate prequel/sequel", which is what users
 * reported: "even if I call using season 3 of anime it shows its watch
 * order saying its a prequel or sequel" — true, but useless.
 *
 * Now `relationSetFor` walks the relations graph TRANSITIVELY (up to
 * depth 3, max 40 nodes), so the response carries the FULL franchise —
 * every season, OVA, movie and side-story — regardless of which entry
 * the caller keyed on. The response adds:
 *
 *   - `watchOrder[]`    — every entry (INCLUDING the queried anime,
 *                         marked `relation: "self"`) sorted by release
 *                         year ascending; each entry carries
 *                         `releaseOrder` (1-based) so a client can
 *                         render "S1 → S2 → S3 → you are here → S4".
 *   - `releaseOrder`    — present on every entry in `related[]` too
 *                         (the position in the watchOrder sequence).
 *   - `rootReleaseOrder`— the queried anime's own releaseOrder.
 *   - `root`            — the queried anime (relation="self").
 *
 * Backward compat: `related[]`, `groups`, `totalRelated`, `count`,
 * `data.related` all keep their v2.5.1 shapes (now with more entries
 * and an extra `releaseOrder` field per entry — additive, no break).
 *
 * ?deep=0 opts out of the transitive walk (returns only direct edges,
 * the v2.5.1 behaviour) for any caller that wants the truncated view.
 */
router.get("/watch-order/:slug", wrap(async (req, res) => {
  const { slug, canonicalKey, canonical, root, entries, source } =
    await relationSetFor(req, req.params.slug);

  // v2.6.0 — apply the relation filter BEFORE enriching (so we don't
  // enrich entries we're about to drop). Self always survives.
  const filter = parseRelationFilter(req);
  const filteredEntries = applyRelationFilter(entries, filter);

  await enrichItemList(filteredEntries, { skipArt: skipArt(req) });

  // Build the queried-entry item (relation="self") and merge it into the
  // release-order sequence so the watch order shows WHERE this season sits.
  const selfSlug = slug || canonical?.slug || "";
  const selfCanonical = root || canonical;
  const selfItem = selfCanonical ? finalizeItem({
    ...animeListItem({ canonical: selfCanonical, identity: { slug: selfSlug } }),
    relation: "self",
    franchiseHops: 0,
  }) : null;

  // v2.5.2: watchOrder = full franchise + the queried anime, sorted by
  // release year. Each entry gets `releaseOrder` (1-based position).
  const watchOrder = sortByReleaseYear([
    ...(selfItem ? [selfItem] : []),
    ...filteredEntries,
  ]);
  watchOrder.forEach((e, i) => { e.releaseOrder = i + 1; });
  const rootReleaseOrder = selfItem ? selfItem.releaseOrder : null;

  // v2.4.0 backward-compat field: `order` = position in the canonical
  // RELATION-bucket sequence (prequel → parent → sequel → sideStory …).
  // Computed on the entries (related, excludes root) so existing clients
  // counting `related.length` keep their mental model.
  const ordered = [];
  for (const bucket of RELATION_ORDER) {
    for (const e of filteredEntries) {
      if ((e.relation || "related") === bucket) ordered.push(e);
    }
  }
  // `releaseOrder` was already assigned on every entry (root + related)
  // above — preserve it through the relation-bucket sort.
  ordered.forEach((e, i) => { e.order = i + 1; });

  const groups = relationsBlock(filteredEntries).groups;
  const responseSlug = selfSlug;

  res.json({
    success: true,
    api: "APIKuoshi",
    kind: "watch-order",
    key: canonicalKey,
    slug: responseSlug,
    source,
    root: selfItem,
    rootReleaseOrder,
    filter: {                                              // v2.6.0
      include: filter.include ? [...filter.include] : null,
      exclude: [...filter.exclude],
      defaulted: filter.defaulted,
    },
    totalInFranchise: watchOrder.length,
    totalRelated: ordered.length,
    count: ordered.length,
    related: ordered,
    watchOrder,
    groups,
    data: {
      slug: responseSlug,
      totalRelated: ordered.length,
      totalInFranchise: watchOrder.length,
      related: ordered,
      watchOrder,
    },
  });
}));

// ================================================================ META
// Rich canonical metadata + MAL-shaped views. Every endpoint here emits the
// SAME unified identity (key/slug/ids/titles) built by core/shape.js.

router.get("/meta", wrap(async (req, res) => {
  const key = keyOf(req);
  const { anilistId, malId, slug, canonical } = await resolveFlexible(key);
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

  const anime = publicAnime(detail || canonical, null, slug);
  // v2.6.0 — merge layer top-up (same as /api/anime): fills the
  // nextAiringEpisode countdown + duration + averageScore + studios
  // + trailer + banner from anilistDetail (cached 24h) when the
  // canonical didn't carry them. /api/meta is now identical to
  // /api/anime for the same key on these v2.6.0 fields.
  await mergeItem(anime, {});
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
  const { anilistId, malId, slug } = await resolveFlexible(keyOf(req));
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
    // v2.4.0: MAL-only entries get the completeness pass too — the index
    // fills anilistId/year/type/episodes/genres when any endpoint knows them
    const item = finalizeItem(applyIdentityIndex(animeListItem({
      identity: { anilistId: null, malId: rMalId, slug: slugFor, title: r.title || "" },
      extra: { poster: r.image || "", type: "", year: null, episodes: null },
    })));
    merged.push({ ...item, votes: r.votes ?? null, source: "mal" });
    if (rMalId) byMal.set(String(rMalId), merged[merged.length - 1]);
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
    const resolved = await resolveFlexible(key);
    malId = resolved.canonical?.malId ?? resolved.malId ?? null;
    identity = { anilistId: resolved.anilistId, malId: resolved.malId, slug: resolved.slug };
    if (!malId) throw new CustomError(`No MAL id known for ${key}`, 404);
  }

  const details = await ishi.malDetails(malId);
  if (!details) throw new CustomError(`Anime ${malId} not found on MAL`, 404);

  // v2.4.0: completeness pass — the identity index may know the AniList
  // side (ids, year, genres) for this MAL entry
  const anime = applyIdentityIndex(animeListItem({ mal: details, identity }));

  const payload = {
    success: true,
    api: "APIKuoshi",
    key: keyForIds({ ...identity, malId }),
    malId,
    anime,
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
    const resolved = await resolveFlexible(key);
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
  const result = await cachedBrowse(req, "meta-trending", () =>
    withFallback(
      async (lane) => {
        if (lane.id === "ishi" && lane.airingBanners) return { data: await lane.airingBanners() };
        if (lane.id === "ishi") return { data: await lane.airing() };
        if (lane.id === "kaze") return lane.trending();
        return null;
      },
      { label: "meta-trending" }
    )
  );
  sendList(res, "trending", result);
}));

// ================================================================ INFRA
// Playback infrastructure: restreams m3u8 playlists and media so browsers
// can play them cross-origin.
//
// v2.5.0 — REFERER-DEFAULT: the megaplay CDN family (anipixcdn/
// nexabloom/qeltrix/zhaevor/quavex…) answers 403 to any fetch without
// their player Referer. All three proxies now send the player Referer
// by default (STREAM_REFERER, env-tunable) and only go Referer-less
// when the caller explicitly passes &ref=none. A custom &ref= overrides.
// Each handler also RETRIES once with the default player Referer when
// the upstream answered 401/403 — a client-supplied bad ref can never
// kill a playable request.
//
// Token-gated CDNs (nexabloom/qeltrix family — 32-hex path pairs) are
// RE-TOKENIZED on every hop: the 90 s HMAC TTL would break mid-playback
// if a playlist-embedded stale token were reused. Each proxied variant/
// segment request re-enters these handlers, so a fresh token is always
// minted before the upstream fetch.

const PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Fetch text upstream with the proxy Referer ladder (401/403 retry). */
async function proxyFetchText(url, referer, extraHeaders = {}, timeout = 20000) {
  const attempt = async (ref) =>
    axios.get(url, {
      responseType: "text",
      timeout,
      maxRedirects: 5,
      headers: {
        "User-Agent": PROXY_UA,
        ...(ref ? { Referer: ref, Origin: new URL(ref).origin } : {}),
        ...extraHeaders,
      },
    });
  try {
    return { res: await attempt(referer), refererUsed: referer, retried: false };
  } catch (err) {
    const status = err?.response?.status;
    const fallback = upstreamReferer(null); // the player origin
    if ((status === 401 || status === 403) && fallback && fallback !== referer) {
      return { res: await attempt(fallback), refererUsed: fallback, retried: true };
    }
    throw err;
  }
}

router.get("/proxy/hls", wrap(async (req, res) => {
  const raw = req.query.url;
  if (!raw || !/^https?:\/\//i.test(raw)) throw new CustomError("Missing/invalid ?url= (absolute http(s) m3u8 URL)", 400);
  const ref = upstreamReferer(req.query.ref); // v2.5.0: Referer-default
  const url = withCdnToken(raw);

  const { res: r, refererUsed } = await proxyFetchText(url, ref);

  const body = String(r.data || "");
  const base = new URL(url.split("?")[0]);
  // keep the SAME referer policy on every rewritten hop — a playlist
  // fetched with ref=none rewrites its children with ref=none too
  const hopRef = refererUsed ? `&ref=${encodeURIComponent(refererUsed)}` : "&ref=none";
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
            ? `URI="/api/proxy/hls?url=${encodeURIComponent(abs)}${hopRef}"`
            : `URI="/api/proxy/video?url=${encodeURIComponent(abs)}${hopRef}"`;
        });
      }
      const abs = new URL(t, base).toString();
      if (t.includes(".m3u8")) return `/api/proxy/hls?url=${encodeURIComponent(abs)}${hopRef}`;
      return `/api/proxy/video?url=${encodeURIComponent(abs)}${hopRef}`;
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
  const ref = upstreamReferer(req.query.ref); // v2.5.0: Referer-default
  const url = withCdnToken(raw);

  let upstream;
  try {
    upstream = await axios.get(url, {
      responseType: "stream",
      timeout: 30000,
      headers: {
        "User-Agent": PROXY_UA,
        ...(ref ? { Referer: ref, Origin: new URL(ref).origin } : {}),
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
  } catch (err) {
    // v2.5.0: one retry through the Referer ladder — a stale client ref
    // (or none) must not kill a segment fetch mid-playback
    const status = err?.response?.status;
    const fallback = upstreamReferer(null);
    if ((status === 401 || status === 403) && fallback && fallback !== ref) {
      upstream = await axios.get(withCdnToken(raw), {
        responseType: "stream",
        timeout: 30000,
        headers: {
          "User-Agent": PROXY_UA,
          Referer: fallback,
          Origin: new URL(fallback).origin,
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
      });
    } else {
      throw err;
    }
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  if (upstream.headers["content-type"]) res.setHeader("Content-Type", upstream.headers["content-type"]);
  if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
  if (upstream.headers["content-range"]) res.setHeader("Content-Range", upstream.headers["content-range"]);
  res.status(upstream.status);
  upstream.data.pipe(res);
}));

/**
 * v2.5.0 — /proxy/subtitle: format-aware subtitle restreamer.
 *   - Source format is SNIFFED from the payload (vtt/srt/ass), never
 *     guessed from the file extension (CDNs disguise payloads).
 *   - ?format=vtt (default) — WebVTT out; an SRT source is converted.
 *   - ?format=srt — SubRip out; a VTT source is converted.
 *   - ?ref=none sends no Referer; anything else overrides the default.
 *   - ?raw=1 skips conversion and echoes the upstream payload bytes.
 *   VTT stays the default so existing <track> consumers are unaffected.
 *   Response headers report what happened:
 *     X-Subtitle-Source-Format / X-Subtitle-Format / X-Subtitle-Converted
 */
router.get("/proxy/subtitle", wrap(async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new CustomError("Missing/invalid ?url=", 400);
  const ref = upstreamReferer(req.query.ref); // v2.5.0: Referer-default
  const wantSrt = String(req.query.format || "").toLowerCase() === "srt";
  const rawPass = req.query.raw === "1";

  const { res: r } = await proxyFetchText(url, ref, {
    Accept: "*/*",
  });
  const body = String(r.data || "");
  const sourceFormat = detectSubtitleFormat(body);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Subtitle-Source-Format", sourceFormat || "unknown");

  if (rawPass) {
    res.setHeader("Content-Type", sourceFormat === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8");
    return res.send(body);
  }

  const out = convertSubtitle(body, wantSrt ? "srt" : "vtt");
  res.setHeader("X-Subtitle-Format", out.format === "srt" ? "srt" : "vtt");
  res.setHeader("X-Subtitle-Converted", out.converted ? "1" : "0");
  res.setHeader("Content-Type", out.format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(out.text);
}));

export default router;
