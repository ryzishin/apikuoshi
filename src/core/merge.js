/**
 * ============================================================
 *  APIKuoshi — src/core/merge.js                      v2.6.0
 * ============================================================
 *  THE POST-SHAPE COMPLETENESS LAYER.
 *
 *  The shape layer (core/shape.js) builds the canonical item from
 *  whatever sources the calling endpoint happens to have — listing,
 *  canonical AniList, MAL details, identity map. But on BROWSE
 *  endpoints (home, trending, schedule, filter, az-list, …) only
 *  the kaze listing is available upstream, so the row leaves shape
 *  with NO anilistId, NO malId, NO year, NO season, NO genres, NO
 *  nextAiringEpisode. The same anime visited on /api/anime carries
 *  the FULL shape; the same anime on /api/home carries almost none
 *  of it. v2.6.0 closes that gap.
 *
 *  mergeIdentityFields() is the post-shape pass that runs AFTER
 *  catalogListItem() and BEFORE finalizeItem() / enrichItemList().
 *  For every row it:
 *
 *    1. Looks up the shared identity index (core/identity.js) by
 *       slug → title → anilistId → malId — whatever it has — and
 *       FILLS every missing field that the index knows about
 *       (anilistId, malId, year, season, status, type, episodes,
 *       genres, synonyms, titles, poster).
 *
 *    2. If anilistId is known (or the index filled it), calls
 *       anilistById(id) — a 24 h cached, ~60 s negative-cache
 *       helper — and top-ups the fields AniList knows that the
 *       index doesn't yet: titleNative, banner, nextAiringEpisode,
 *       averageScore, duration, studios, trailer.
 *
 *    3. Remembers the row's slug↔title pair back into the index
 *       (cheap, always-safe) so the NEXT request for the same row
 *       benefits (the index only ever grows; it never fabricates).
 *
 *  Contract (same as everywhere else in the shape layer):
 *    - Never invents. Missing fields stay null/empty/[].
 *    - Never overrides a non-empty value with an empty one
 *      (the shape's "pick" already did that ordering).
 *    - Never blocks the response — every AniList call is
 *      time-capped (12 s) and any failure degrades to "no fill".
 *    - Idempotent: running it twice on the same row is a no-op
 *      after the first call.
 *
 *  The merge layer is the ONE place where "data exists somewhere
 *  in the system" gets unified into the response. The shape layer
 *  stays the canonical field picker; the merge layer is the
 *  "the data is there, USE it" pass.
 * ============================================================
 */
import { lookupAnime, rememberAnime, rememberSlugTitle, queueIdentityBackfill } from "./identity.js";
import { anilistById } from "./anilist.js";
import { keyForIds, normalizeStatus, normalizeType } from "./shape.js";

/* Fields the index+AniList top-up can fill on a list row. Keep the
 * null-policy contract — string fields → "", array fields → [],
 * ids/numbers → null when still unknown after the merge. */
const STR_FIELDS = ["title", "titleRomaji", "titleEnglish", "titleNative", "status", "season", "rating"];
const ARR_FIELDS = ["synonyms", "genres"];
const NUM_FIELDS = ["anilistId", "malId", "year", "episodes", "score"];

/* Bounded-concurrency merge — keeps the merge fast (N parallel
 * anilistById calls, capped) so a 30-row browse page tops out at
 * the queue's batch size, not at "one call per row in series". */
const MERGE_CONCURRENCY = parseInt(process.env.MERGE_CONCURRENCY || "8", 10) || 8;

/** Top-up ONE item from the shared identity index. Mutates the item.
 *
 * v2.6.1 — THIS IS THE "REUSE OF SCRAPED DATA" PASS. The kaze
 * extractors each pull a different field subset (spotlight:
 * description+rating+quality+releaseDate; trending: total+sub+dub+
 * type; upcoming: releaseDate; etc.). catalogListItem() calls
 * rememberAnime(raw) BEFORE shaping, so every kaze row's scraped
 * fields accumulate in the index keyed by slug. fillFromIndex()
 * then reads those accumulated fields back and fills the row.
 *
 * No AniList, no external fetching — just reuse of data the
 * system has already scraped. This is the "if we have data from
 * other endpoints, what's the problem of getting data to fill
 * empty or null data?" fix the user asked for. */
function fillFromIndex(item) {
  if (!item || typeof item !== "object") return item;
  const rec = lookupAnime({ slug: item.slug, title: item.title, anilistId: item.anilistId, malId: item.malId });
  if (!rec) return item;

  // link the slug↔title pair back so the next call hits the index first
  if (item.slug && (rec.title || item.title)) rememberSlugTitle(item.slug, rec.title || item.title);

  // Identity fields (ids + AniList-style metadata)
  if (item.anilistId == null && rec.anilistId != null) item.anilistId = rec.anilistId;
  if (item.malId == null && rec.malId != null) item.malId = rec.malId;
  if (!item.year && rec.year != null) item.year = rec.year;
  if (!item.season && rec.season) item.season = String(rec.season).toUpperCase();
  if (!item.status && rec.status) item.status = normalizeStatus(rec.status);
  if (!item.type && rec.format) item.type = normalizeType(rec.format);
  if (item.episodes == null && rec.episodes != null) item.episodes = rec.episodes;
  if (item.duration == null && rec.duration != null) item.duration = rec.duration;
  if (item.averageScore == null && rec.averageScore != null) item.averageScore = rec.averageScore;
  if (Array.isArray(rec.genres) && rec.genres.length && (!Array.isArray(item.genres) || item.genres.length === 0)) item.genres = rec.genres.slice();
  if (Array.isArray(rec.synonyms) && rec.synonyms.length && (!Array.isArray(item.synonyms) || item.synonyms.length === 0)) item.synonyms = rec.synonyms.slice();
  if (!item.titleEnglish && rec.titleEnglish) item.titleEnglish = rec.titleEnglish;
  if (!item.titleNative && rec.titleNative) item.titleNative = rec.titleNative;
  if (!item.titleRomaji && rec.titleRomaji) item.titleRomaji = rec.titleRomaji;
  if (!item.title && rec.title) item.title = rec.title;
  if (!item.poster && rec.poster) { item.poster = rec.poster; if (item.artSource === null) item.artSource = "upstream"; }
  // v2.6.0 — the airing countdown (AniList path)
  if (!item.nextAiringEpisode && rec.nextAiringEpisode) {
    item.nextAiringEpisode = rec.nextAiringEpisode;
  }

  // v2.6.1 — UPSTREAM-SCRAPED FIELDS accumulator passback. The kaze
  // extractors pulled these from various upstream pages; the index
  // accumulated them by slug; fill them now so the row carries the
  // UNION of every extractor's data. Never overwrite a non-empty
  // value (the row's own extractor data wins; the index only fills
  // what THIS row's extractor didn't pull).
  if (!item.description && rec.description) item.description = rec.description;
  if (!item.synopsis && rec.description) item.synopsis = rec.description;
  if (!item.rating && rec.rating) item.rating = rec.rating;
  if (!item.quality && rec.quality) item.quality = rec.quality;
  if (!item.releaseDate && rec.releaseDate) item.releaseDate = rec.releaseDate;
  if ((!item.sub || item.sub === 0) && rec.sub != null && rec.sub > 0) item.sub = rec.sub;
  if ((!item.dub || item.dub === 0) && rec.dub != null && rec.dub > 0) item.dub = rec.dub;
  if ((!item.total || item.total === 0) && rec.total != null && rec.total > 0) item.total = rec.total;
  if (!item.airingTime && rec.airingTime) item.airingTime = rec.airingTime;
  if (item.airingAt == null && rec.airingAt != null) item.airingAt = rec.airingAt;
  if (item.airingEpisode == null && rec.airingEpisode != null) item.airingEpisode = rec.airingEpisode;

  // re-derive the key once ids are filled
  if (item.anilistId || item.malId) {
    item.key = keyForIds({ anilistId: item.anilistId, malId: item.malId, slug: item.slug });
  }
  return item;
}

/** Top-up ONE item from AniList (cached, time-capped, never throws). */
async function fillFromAnilist(item) {
  if (!item || typeof item !== "object") return item;
  const alId = item.anilistId ? parseInt(item.anilistId, 10) : null;
  if (!Number.isFinite(alId)) return item;
  try {
    const detail = await anilistById(alId);
    if (!detail) return item;
    // merge detail into the index so the NEXT request hits the index
    // first (no AniList call) — this is what makes the merge layer
    // accelerate over time as the index grows.
    rememberAnime(detail);
    // fill fields the index doesn't carry (yet)
    if (!item.titleNative && detail.titleNative) item.titleNative = detail.titleNative;
    if (!item.banner && detail.banner) item.banner = detail.banner;
    if (item.score == null && detail.averageScore != null) item.score = detail.averageScore;
    if (item.episodes == null && detail.episodes != null) item.episodes = detail.episodes;
    if (!item.season && detail.season) item.season = String(detail.season).toUpperCase();
    if (!item.year && detail.year) item.year = detail.year;
    if (!item.status && detail.status) item.status = normalizeStatus(detail.status);
    if (!item.type && detail.format) item.type = normalizeType(detail.format);
    if (Array.isArray(detail.synonyms) && detail.synonyms.length && (!Array.isArray(item.synonyms) || item.synonyms.length === 0)) item.synonyms = detail.synonyms.slice();
    if (Array.isArray(detail.genres) && detail.genres.length && (!Array.isArray(item.genres) || item.genres.length === 0)) item.genres = detail.genres.slice();
    if (!item.titleRomaji && detail.titleRomaji) item.titleRomaji = detail.titleRomaji;
    if (!item.titleEnglish && detail.titleEnglish) item.titleEnglish = detail.titleEnglish;
    if (!item.title && detail.title) item.title = detail.title;
    if (!item.poster && detail.poster) { item.poster = detail.poster; if (item.artSource === null) item.artSource = "upstream"; }
    // The v2.6.0 headline field — nextAiringEpisode (countdown).
    // AniList's detail query already asks for it; shape.js drops it
    // because it's not in the core pick-list. merge.js puts it back
    // so /api/schedule, /api/airing, /api/home can carry the countdown.
    if (!item.nextAiringEpisode && detail.nextAiringEpisode) {
      item.nextAiringEpisode = {
        episode: detail.nextAiringEpisode.episode,
        airingAt: detail.nextAiringEpisode.airingAt,
        countdownSeconds: detail.nextAiringEpisode.countdownSeconds ?? detail.nextAiringEpisode.timeUntilAiring,
      };
    }
    // re-derive key in case anilist filled malId via shapeMedia
    if (item.anilistId || item.malId) {
      item.key = keyForIds({ anilistId: item.anilistId, malId: item.malId, slug: item.slug });
    }
  } catch {
    // AniList outage / rate-limit — degrade silently. The shape
    // contract still holds (missing fields stay null). The negative
    // cache (45 s) keeps us from hammering AniList on every row.
  }
  return item;
}

/**
 * Apply the merge layer to ONE item. Mutates and returns it.
 * Used by /api/anime, /api/meta — anywhere a single item is shaped
 * outside a list context (so the merge layer still top-ups it
 * even though it didn't go through enrichItemList).
 */
export async function mergeItem(item, { skipAnilist = false } = {}) {
  if (!item || typeof item !== "object") return item;
  fillFromIndex(item);
  if (!skipAnilist) await fillFromAnilist(item);
  // background-anchor anything still missing ids (the NEXT request
  // for this row will then carry the full shape — the merge layer is
  // best-effort for the CURRENT response but lazy-perfect for the next).
  if (item.anilistId == null && item.malId == null && (item.title || item.slug)) {
    queueIdentityBackfill({ slug: item.slug, title: item.title });
    rememberSlugTitle(item.slug, item.title);
  }
  return item;
}

/**
 * Apply the merge layer to a LIST of items. Mutates each item in
 * place and returns the list. Bounded concurrency (MERGE_CONCURRENCY)
 * so a 30-row browse page doesn't spawn 30 AniList calls in series.
 *
 * Returns the same array (for chaining); callers usually do:
 *   items = await mergeIdentityFields(items);
 *   await enrichItemList(items, { skipArt });
 */
export async function mergeIdentityFields(items, { skipAnilist = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;

  // PASS 1 — synchronous index fill (zero upstream calls; usually
  // resolves most rows in steady state since the index is warm).
  for (const it of list) fillFromIndex(it);

  // PASS 2 — bounded-concurrency AniList top-up for rows that still
  // have anilistId. Rows without ids are skipped here (they're
  // background-backfilled for the NEXT request).
  if (skipAnilist) return list;
  const queue = list.filter(it => it && Number.isFinite(parseInt(it.anilistId, 10)));
  for (let i = 0; i < queue.length; i += MERGE_CONCURRENCY) {
    const batch = queue.slice(i, i + MERGE_CONCURRENCY);
    await Promise.all(batch.map(it => fillFromAnilist(it).catch(() => {})));
  }
  return list;
}

/**
 * v2.6.0 — CROSS-SECTION MERGE for object-shaped payloads (home,
 * top-ten, trending-sidebar). When the same slug appears in two
 * sections with different field richness (e.g. home/spotlights
 * has `description` + `rating`, home/trending has `total`, home/
 * topAiring has neither), merge them so the row carries the
 * UNION of all fields, not the WORST set.
 *
 * Mutates items in place; returns the array for convenience.
 */
export function crossSectionMerge(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const byId = new Map();
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const id = it.slug || it.key || (it.anilistId ? "a:" + it.anilistId : null) || (it.malId ? "m:" + it.malId : null);
    if (!id) { byId.set(Symbol(), it); continue; }
    const existing = byId.get(id);
    if (!existing) { byId.set(id, it); continue; }
    // merge the two — keep the non-empty side per field
    for (const f of STR_FIELDS) if (!existing[f] && it[f]) existing[f] = it[f];
    for (const f of ARR_FIELDS) if (Array.isArray(it[f]) && it[f].length > (Array.isArray(existing[f]) ? existing[f].length : 0)) existing[f] = it[f].slice();
    for (const f of NUM_FIELDS) if (existing[f] == null && it[f] != null) existing[f] = it[f];
    // also keep the union of any extension fields (sub, dub, total, rank, etc.)
    for (const k of Object.keys(it)) {
      if (STR_FIELDS.includes(k) || ARR_FIELDS.includes(k) || NUM_FIELDS.includes(k)) continue;
      if (existing[k] == null || existing[k] === "" || existing[k] === 0) {
        if (it[k] != null && it[k] !== "" && it[k] !== 0) existing[k] = it[k];
      }
    }
  }
  // Return the unique-merged list, preserving insertion order
  return Array.from(byId.values());
}
