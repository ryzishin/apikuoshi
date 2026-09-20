/**
 * ============================================================
 *  APIKuoshi — src/core/identity.js                   v2.4.0
 * ============================================================
 *  THE SHARED IDENTITY INDEX — one cross-endpoint record of
 *  everything the system has ALREADY resolved about an anime.
 *
 *  WHY: v2.3 browse/catalog rows were slug-anchored only — a row
 *  from /api/trending carried anilistId: null / malId: null even
 *  after /api/anime had already resolved the very same title to
 *  its AniList/MAL identity. A 200 with half the fields is a
 *  failure, not a success. The data existed in the system — it
 *  just was not shared. This module shares it.
 *
 *  WHAT IT STORES (per anime, one merged record):
 *    anilistId malId slug listingSlug title titleRomaji
 *    titleEnglish titleNative synonyms genres year episodes
 *    format status poster banner
 *  keyed by every address it is known by:
 *    a:<anilistId>  m:<malId>  s:<slug>  t:<normalized title>
 *
 *  HARD RULES:
 *    1. Never fabricate. Records are written only from real
 *       resolutions (AniList search/byId/detail/relations, MAL
 *       details, kaze listing pages, slug→title links observed on
 *       catalog rows). Merges never overwrite a known value with
 *       an unknown one.
 *    2. Never block a response. Lookups are synchronous Map reads;
 *       background anchoring happens on a separate bounded queue.
 *    3. Stale slugs are data too. When a catalog row carries a
 *       slug whose watch page is gone, the slug→title link is
 *       still remembered so identity resolution gets faster and
 *       /api/resolve keeps working for entries any endpoint
 *       returned.
 *
 *  v2.4.0 completeness contract (enforced with this module):
 *    every anime-shaped entry carries anilistId/malId/year/status/
 *    genres/synonyms/title* whenever ANY endpoint of this process
 *    has resolved them — across the whole surface, not just the
 *    endpoint that did the resolving.
 * ============================================================
 */
import { titleSlug, cleanListingSlug } from "./shape.js";

const MAX_RECORDS = 5000;

// ------------------------------------------------------------- store
const byKey = new Map(); // key -> record (shared object references)

function normTitle(t = "") {
  return String(t || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'"]/g, "")
    .replace(/[,:;!?.'"()\[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function touch(key) {
  const rec = byKey.get(key);
  if (rec) {
    byKey.delete(key);
    byKey.set(key, rec);
  }
  return rec || null;
}

function link(record, key) {
  if (!key) return;
  const existing = byKey.get(key);
  if (existing === record) return;
  if (existing) {
    // merge the older record INTO this one and re-point the key
    mergeInto(record, existing);
    for (const k of [...existing._keys]) {
      byKey.set(k, record);
      record._keys.add(k);
    }
  }
  byKey.set(key, record);
  record._keys.add(key);
  trimIfNeeded();
}

function trimIfNeeded() {
  while (byKey.size > MAX_RECORDS * 2) {
    const oldest = byKey.keys().next().value;
    const rec = byKey.get(oldest);
    byKey.delete(oldest);
    if (rec) rec._keys.delete(oldest);
  }
}

/** best-value merge: known beats unknown, richer beats thinner */
const better = (a, b) => {
  if (a === null || a === undefined || a === "") return b ?? null;
  if (b === null || b === undefined || b === "") return a ?? null;
  if (Array.isArray(a) && Array.isArray(b)) return a.length >= b.length ? a : b;
  return a;
};

function mergeInto(target, src) {
  for (const f of ["anilistId", "malId", "title", "titleRomaji", "titleEnglish",
    "titleNative", "year", "episodes", "format", "status", "poster", "banner", "season"]) {
    target[f] = better(target[f], src[f]);
  }
  target.genres = better(target.genres, src.genres) || [];
  target.synonyms = better(target.synonyms, src.synonyms) || [];
  if (src.slug && !target.slugs.has(src.slug)) target.slugs.add(src.slug);
  if (src.listingSlug) target.listingSlug = target.listingSlug || src.listingSlug;
  if (src.titles) for (const t of src.titles) target.titles.add(t);
}

/** A record is the shared object; _keys/_slugs/_titles are bookkeeping. */
function newRecord(data = {}) {
  return {
    anilistId: data.anilistId ?? null,
    malId: data.malId ?? null,
    listingSlug: data.listingSlug || data.slug || null,
    slug: data.slug || data.listingSlug || null,
    title: data.title ?? null,
    titleRomaji: data.titleRomaji ?? null,
    titleEnglish: data.titleEnglish ?? null,
    titleNative: data.titleNative ?? null,
    synonyms: Array.isArray(data.synonyms) ? data.synonyms : [],
    genres: Array.isArray(data.genres) ? data.genres : [],
    year: data.year ?? null,
    episodes: data.episodes ?? null,
    format: data.format ?? data.type ?? null,
    status: data.status ?? null,
    season: data.season ?? null,
    poster: data.poster ?? null,
    banner: data.banner ?? null,
    // v2.6.1 — UPSTREAM-SCRAPED FIELDS accumulator. The kaze extractors
    // each pull a different field subset from the SAME upstream page
    // (spotlight has description+rating+quality+releaseDate, trending
    // has total+sub+dub+type, topAiring has type only, etc.). We
    // accumulate ALL of them by slug so any endpoint that touches
    // the same slug carries the UNION of fields every extractor has
    // ever scraped. No AniList, no external fetching — pure reuse
    // of data the system has already scraped.
    description: data.description ?? data.synopsis ?? null,
    rating: data.rating ?? null,
    quality: data.quality ?? null,
    releaseDate: data.releaseDate ?? data.date ?? null,
    sub: Number.isFinite(data.sub) ? data.sub : null,
    dub: Number.isFinite(data.dub) ? data.dub : null,
    total: Number.isFinite(data.total) ? data.total : null,
    airingTime: data.airingTime ?? data.time ?? null,
    airingAt: Number.isFinite(data.airingAt) ? data.airingAt : null,
    airingEpisode: Number.isFinite(data.airingEpisode) || Number.isFinite(data.episode_no)
      ? (Number.isFinite(data.airingEpisode) ? data.airingEpisode : data.episode_no) : null,
    duration: data.duration ?? null,
    averageScore: data.averageScore ?? null,
    nextAiringEpisode: data.nextAiringEpisode ?? null,
    _keys: new Set(),
    slugs: new Set(),
    titles: new Set(),
  };
}

// ------------------------------------------------------------- public API

/**
 * Remember any anime-shaped object. Accepts canonical AniList entries,
 * MAL details, kaze listing rows, catalog items, /api/anime payloads —
 * anything with a title and any identifier. Null-safe, idempotent.
 */
export function rememberAnime(entry = {}) {
  try {
    if (!entry || typeof entry !== "object") return null;
    const slug = cleanListingSlug(entry.slug || entry.listingSlug || entry.listingId || "");
    const title = entry.title || entry.titleRomaji || entry.titleEnglish || "";
    const anilistId = entry.anilistId ? parseInt(entry.anilistId, 10) || null : null;
    const malId = entry.malId ? parseInt(entry.malId, 10) || null : null;
    if (!anilistId && !malId && !slug && !title) return null;

    // find an existing record to merge into (id-first, then slug, then title)
    let rec = null;
    if (anilistId) rec = touch(`a:${anilistId}`) || rec;
    if (malId) rec = touch(`m:${malId}`) || rec;
    if (slug) rec = touch(`s:${slug.toLowerCase()}`) || rec;
    const nt = normTitle(title);
    if (nt) rec = touch(`t:${nt}`) || rec;
    if (!rec) rec = newRecord({});

    // merge fields (never downgrade)
    rec.anilistId = rec.anilistId || anilistId;
    rec.malId = rec.malId || malId;
    rec.title = better(rec.title, entry.title);
    rec.titleRomaji = better(rec.titleRomaji, entry.titleRomaji);
    rec.titleEnglish = better(rec.titleEnglish, entry.titleEnglish);
    rec.titleNative = better(rec.titleNative, entry.titleNative ?? entry.titleJapanese);
    rec.year = rec.year ?? (entry.year ?? entry.seasonYear ?? null);
    rec.episodes = rec.episodes ?? (entry.episodes ?? entry.total ?? null);
    rec.format = rec.format ?? (entry.format ?? entry.type ?? null);
    rec.status = rec.status ?? entry.status ?? null;
    rec.season = rec.season ?? entry.season ?? null;
    rec.duration = rec.duration ?? entry.duration ?? null;
    rec.averageScore = rec.averageScore ?? entry.averageScore ?? null;
    rec.poster = rec.poster ?? (entry.poster ?? entry.image ?? null);
    rec.banner = rec.banner ?? entry.banner ?? null;
    // v2.6.1 — UPSTREAM-SCRAPED FIELDS accumulator. The kaze extractors
    // each pull a different field subset (spotlight: description+rating+
    // quality+releaseDate; trending: total+sub+dub+type; upcoming:
    // releaseDate; etc.). Accumulate ALL of them — never downgrade,
    // never overwrite a non-empty value with an empty one. "Better"
    // rule: keep the non-empty side.
    rec.description = better(rec.description, entry.description ?? entry.synopsis);
    rec.rating = better(rec.rating, entry.rating);
    rec.quality = better(rec.quality, entry.quality);
    rec.releaseDate = better(rec.releaseDate, entry.releaseDate ?? entry.date);
    if (Number.isFinite(entry.sub) && (rec.sub == null || entry.sub > rec.sub)) rec.sub = entry.sub;
    if (Number.isFinite(entry.dub) && (rec.dub == null || entry.dub > rec.dub)) rec.dub = entry.dub;
    if (Number.isFinite(entry.total) && (rec.total == null || entry.total > rec.total)) rec.total = entry.total;
    rec.airingTime = better(rec.airingTime, entry.airingTime ?? entry.time);
    if (Number.isFinite(entry.airingAt) && (rec.airingAt == null || entry.airingAt > rec.airingAt)) rec.airingAt = entry.airingAt;
    if (Number.isFinite(entry.airingEpisode) && (rec.airingEpisode == null || entry.airingEpisode > rec.airingEpisode)) rec.airingEpisode = entry.airingEpisode;
    if (Number.isFinite(entry.episode_no) && (rec.airingEpisode == null || entry.episode_no > rec.airingEpisode)) rec.airingEpisode = entry.episode_no;
    // v2.6.0 — airing countdown is per-show state that mutates daily.
    // Always overwrite (the latest source wins) so the index reflects
    // the most recent observation rather than the first.
    if (entry.nextAiringEpisode && typeof entry.nextAiringEpisode === "object") {
      rec.nextAiringEpisode = entry.nextAiringEpisode;
    }
    if (Array.isArray(entry.genres) && entry.genres.length > rec.genres.length) rec.genres = entry.genres;
    if (Array.isArray(entry.synonyms) && entry.synonyms.length > rec.synonyms.length) rec.synonyms = entry.synonyms;

    // address bookkeeping
    if (title) rec.titles.add(title);
    if (entry.titleRomaji) rec.titles.add(entry.titleRomaji);
    if (entry.titleEnglish) rec.titles.add(entry.titleEnglish);
    for (const s of entry.synonyms || []) if (s) rec.titles.add(s);
    if (slug) {
      rec.slugs.add(slug);
      rec.listingSlug = rec.listingSlug || slug;
    }

    // (re)link keys
    if (rec.anilistId) link(rec, `a:${rec.anilistId}`);
    if (rec.malId) link(rec, `m:${rec.malId}`);
    for (const s of rec.slugs) link(rec, `s:${s.toLowerCase()}`);
    for (const t of rec.titles) {
      const k = `t:${normTitle(t)}`;
      if (k.length > 4) link(rec, k);
    }
    return rec;
  } catch {
    return null;
  }
}

/**
 * Observe a slug↔title pair from a catalog row — cheap, always-safe
 * link that keeps /api/resolve working even for slugs whose upstream
 * page has vanished. Never blocks, never throws.
 */
export function rememberSlugTitle(slug, title) {
  const s = cleanListingSlug(slug || "");
  if (!s || !title) return;
  rememberAnime({ slug: s, title });
}

/**
 * Look up everything known about an anime by ANY address.
 * Returns a plain merged record (no internals) or null.
 */
export function lookupAnime({ anilistId = null, malId = null, slug = "", title = "" } = {}) {
  let rec = null;
  if (anilistId) rec = byKey.get(`a:${parseInt(anilistId, 10)}`) || rec;
  if (malId) rec = byKey.get(`m:${parseInt(malId, 10)}`) || rec;
  const s = cleanListingSlug(slug || "").toLowerCase();
  if (!rec && s) rec = byKey.get(`s:${s}`) || null;
  if (!rec) {
    for (const t of [title, titleSlug(title || "")]) {
      const k = `t:${normTitle(t)}`;
      if (k.length > 4 && byKey.has(k)) { rec = byKey.get(k); break; }
    }
  }
  if (!rec) return null;
  return {
    anilistId: rec.anilistId,
    malId: rec.malId,
    slug: rec.slug,
    listingSlug: rec.listingSlug,
    title: rec.title,
    titleRomaji: rec.titleRomaji,
    titleEnglish: rec.titleEnglish,
    titleNative: rec.titleNative,
    synonyms: rec.synonyms,
    genres: rec.genres,
    year: rec.year,
    episodes: rec.episodes,
    format: rec.format,
    status: rec.status,
    season: rec.season,
    duration: rec.duration,
    averageScore: rec.averageScore,
    poster: rec.poster,
    banner: rec.banner,
    nextAiringEpisode: rec.nextAiringEpisode,
    // v2.6.1 — upstream-scraped field accumulator passback
    description: rec.description,
    rating: rec.rating,
    quality: rec.quality,
    releaseDate: rec.releaseDate,
    sub: rec.sub,
    dub: rec.dub,
    total: rec.total,
    airingTime: rec.airingTime,
    airingAt: rec.airingAt,
    airingEpisode: rec.airingEpisode,
  };
}

/** Number of distinct anime currently indexed (for /api/health). */
export function identityStats() {
  const seen = new Set();
  for (const rec of byKey.values()) seen.add(rec);
  return { anime: seen.size, keys: byKey.size };
}

// ------------------------------------------------------- background backfill
/**
 * Bounded background queue that anchors catalog rows which are still
 * missing ids. Concurrency 2 + 1.2 s spacing keeps us far below AniList's
 * degraded rate limit; results land in the index so every endpoint (not
 * just the one that triggered the backfill) serves the complete shape.
 */
const QUEUE = [];
const QUEUED = new Set();
let running = 0;
const MAX_CONCURRENT = 2;

function enqueueBackfill({ slug = "", title = "" }) {
  const key = `b:${cleanListingSlug(slug).toLowerCase()}|${normTitle(title)}`;
  if (QUEUED.has(key) || QUEUE.length > 60) return;
  QUEUED.add(key);
  QUEUE.push({ key, slug, title });
  pump();
}

async function pump() {
  while (running < MAX_CONCURRENT && QUEUE.length) {
    const job = QUEUE.shift();
    running++;
    runJob(job).finally(() => {
      QUEUED.delete(job.key);
      running--;
      setTimeout(pump, 1200).unref?.();
    });
  }
}

async function runJob({ slug, title }) {
  try {
    const existing = lookupAnime({ slug, title });
    if (existing?.anilistId) return; // someone resolved it meanwhile
    const query = title || titleSlug(slug).replace(/-/g, " ");
    if (!query) return;
    const { anchorTitleToAnilistQuiet } = await import("./keys.js");
    const anilistId = await anchorTitleToAnilistQuiet(query);
    if (!anilistId) return;
    const { anilistById } = await import("./anilist.js");
    const canonical = await anilistById(anilistId);
    if (canonical) {
      rememberAnime({ ...canonical, slug: slug || canonical.slug });
    }
  } catch { /* background — never surfaces */ }
}

/**
 * Called by list-shaping when a row lacks ids. Fire-and-forget;
 * the CURRENT response is not modified by the backfill (the next
 * one benefits — steady-state completeness without latency cost).
 */
export function queueIdentityBackfill({ slug = "", title = "" } = {}) {
  try {
    if (!enrichmentWanted()) return;
    enqueueBackfill({ slug, title });
  } catch { /* never surface */ }
}

function enrichmentWanted() {
  return process.env.IDENTITY_BACKFILL !== "0";
}

export default {
  rememberAnime, rememberSlugTitle, lookupAnime, identityStats, queueIdentityBackfill,
};
