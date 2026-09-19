/**
 * ============================================================
 *  APIKuoshi — src/core/shape.js                      v2.3.0
 * ============================================================
 *  THE ONE NORMALIZATION LAYER.
 *
 *  Every anime-shaped object that leaves the API passes through
 *  this module — /api/anime, /api/meta/*, /api/search,
 *  /api/suggestions, /api/resolve, /api/filter, /api/genre,
 *  /api/type, /api/status, /api/az-list, /api/seasons,
 *  /api/watch-order, /api/meta/season, /api/meta/trending, the
 *  whole BROWSE/CATALOG surface and the anime/episode blocks
 *  inside /api/chain all build their payloads with the builders
 *  below.
 *
 *  CONTRACT (enforced here, and nowhere else):
 *
 *  1. Same core field set, same names, same nesting depth on
 *     every anime-shaped response:
 *       key slug anilistId malId title titleRomaji titleEnglish
 *       titleNative synonyms poster cover type season year
 *       episodes status score rating genres artSource
 *     Detail resources add: banner backdrop logo synopsis (and
 *     its alias description).
 *
 *  2. slug is ALWAYS present and non-empty for anything that has
 *     a listing slug or a title — it survives every transformation.
 *
 *  3. key resolution order: anilist:<id> → mal:<id> → slug.
 *     key is "" only when literally nothing is known.
 *
 *  4. Null policy — consistent everywhere, never mixed:
 *       - string fields  → "" when unknown
 *       - array fields   → [] when unknown
 *       - id/number refs → null when unknown
 *       - ART fields (poster/cover/backdrop/logo/artSource)
 *         → null when no source provided anything (explicit,
 *         never missing — v2.3.0 enrichment contract).
 *     (so a client can never see null-vs-missing divergence).
 *
 *  5. No upstream data is invented. Derived fields (slug from a
 *     title) are deterministic addresses, not fake metadata.
 *     Enrichment providers (kitsu/tmdb) only FILL gaps.
 *
 *  6. Shared vocabularies (v2.3.0): status and type are
 *     normalized to ONE vocabulary on every surface — see
 *     normalizeStatus / normalizeType below.
 * ============================================================
 */

// ---------------------------------------------------------------- slugs

/** Deterministic slug from any title — the universal fallback address. */
export function titleSlug(title = "") {
  return String(title)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "";
}

/** Listing slugs may arrive with a watch-path suffix ("/ep-3") — clean it. */
export function cleanListingSlug(slug = "") {
  return String(slug || "")
    .split("/")[0]
    .trim();
}

/** Does this look like a kaze listing slug (kebab-case, possibly suffixed)? */
export function looksLikeListingSlug(s = "") {
  const v = cleanListingSlug(s);
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(v);
}

/** "frieren-odmau" -> "frieren odmau" (for title searches seeded by a slug). */
export function titleFromSlug(slug = "") {
  return cleanListingSlug(slug).replace(/-/g, " ").trim();
}

// ---------------------------------------------------------------- vocabularies

/**
 * ONE status vocabulary across every surface. AniList enums
 * (RELEASING / FINISHED / NOT_YET_RELEASED …), kaze listing strings
 * ("Currently Airing" / "Finished Airing" …) and casual inputs
 * ("ongoing" / "upcoming") all map onto the same five labels.
 * Unknown vocabularies pass through untouched (never invented).
 */
export function normalizeStatus(raw = "") {
  const s = String(raw || "").trim();
  if (!s) return "";
  const k = s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (["finished", "finished airing", "completed", "complete"].includes(k)) return "Finished Airing";
  if (["releasing", "currently airing", "airing", "ongoing"].includes(k)) return "Currently Airing";
  if (["not yet released", "not yet aired", "upcoming", "not yet released"].includes(k)) return "Not Yet Aired";
  if (["cancelled", "canceled"].includes(k)) return "Cancelled";
  if (["hiatus", "on hiatus"].includes(k)) return "On Hiatus";
  return s;
}

/**
 * ONE type vocabulary: AniList format enums (MOVIE, TV_SHORT …)
 * and kaze card strings ("Movie", "TV" …) map onto the same labels.
 */
export function normalizeType(raw = "") {
  const s = String(raw || "").trim();
  if (!s) return "";
  const k = s.toUpperCase().replace(/[\s_-]+/g, "");
  const map = {
    TV: "TV", TVSHORT: "TV Short", MOVIE: "Movie", OVA: "OVA",
    ONA: "ONA", SPECIAL: "Special", MUSIC: "Music",
  };
  return map[k] || s;
}

// ---------------------------------------------------------------- keys

/** Canonical key for a set of known identifiers. anilist → mal → slug. */
export function keyForIds({ anilistId = null, malId = null, slug = "" } = {}) {
  if (anilistId) return `anilist:${anilistId}`;
  if (malId) return `mal:${malId}`;
  const s = cleanListingSlug(slug) || titleSlug(slug);
  return s || "";
}

// ---------------------------------------------------------------- builders

const str = (v) => (v === null || v === undefined ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  // "24 eps" / "ep 12" — tolerant numeric extraction for upstream strings
  if (typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(v.trim())) {
    const m = v.match(/\d+(\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Art fields use the explicit-null policy: "" is normalized to null. */
const artStr = (v) => {
  const s = str(v);
  return s === "" ? null : s;
};

/**
 * Pick the best value for each core field from several candidate
 * sources. `sources` is an ordered list of partial objects — the
 * first source that has a non-empty value wins.
 */
function pick(sources, field, kind) {
  for (const s of sources) {
    if (!s) continue;
    const v = s[field];
    if (kind === "arr") { if (Array.isArray(v) && v.length) return v; continue; }
    if (kind === "obj") { if (v && typeof v === "object" && !Array.isArray(v)) return v; continue; }
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return kind === "arr" ? [] : kind === "str" ? "" : null;
}

/**
 * The canonical anime RESOURCE (detail shape).
 * Used by /api/anime, /api/meta, /api/resolve, /api/chain `anime`,
 * and any endpoint that returns "the anime itself".
 *
 * `parts` (any subset, ordered best-first per field):
 *   canonical   — AniList-shaped entry (see core/anilist.js shapeMedia)
 *   listing     — kaze lane info { listingId/slug, title, titleAlt, poster, type, status, genres, episodes }
 *   mal         — MAL details { malId, title, titleEnglish, titleJapanese, image, ... }
 *   identity    — { anilistId, malId, slug, title } from core/keys.js
 *   extra       — explicit overrides, always win (e.g. computed endpoints)
 */
export function canonicalAnime({ canonical = null, listing = null, mal = null, identity = null, extra = null } = {}) {
  const sources = [extra, canonical, listing, mal, identity].filter(Boolean);

  const anilistId = num(pick(sources, "anilistId", "num"));
  const malId = num(pick(sources, "malId", "num"));

  // slug: a real listing slug beats a title-derived slug
  const listingSlug =
    cleanListingSlug((listing && (listing.listingId || listing.slug)) || (identity && identity.slug) || "");
  const titleForSlug = pick(sources, "title", "str") || pick(sources, "titleRomaji", "str");
  const slug = listingSlug || titleSlug(titleForSlug);

  const title = pick(sources, "title", "str");
  const titleEnglish = pick(sources, "titleEnglish", "str");
  const titleRomaji =
    pick(sources, "titleRomaji", "str") ||
    pick([listing], "titleAlt", "str") ||
    (title && !titleEnglish ? title : "") ||
    title;
  const titleNative = pick(sources, "titleNative", "str") || pick(sources, "titleJapanese", "str");

  const synopsis = str(pick(sources, "description", "str") || pick(sources, "synopsis", "str"));

  const out = {
    key: keyForIds({ anilistId, malId, slug }),
    slug,
    anilistId,
    malId,
    title,
    titleRomaji: titleRomaji || "",
    titleEnglish: titleEnglish || "",
    titleNative: titleNative || "",
    synonyms: arr(pick(sources, "synonyms", "arr")),
    // art fields — explicit-null policy (see contract §4). The
    // enrichment chain (core/enrich.js) fills these after shaping;
    // artSource records which provider supplied the winning poster.
    poster: artStr(pick(sources, "poster", "str") || pick([mal], "image", "str")),
    cover: artStr(pick(sources, "cover", "str")),
    backdrop: artStr(pick(sources, "backdrop", "str")),
    logo: artStr(pick(sources, "logo", "str")),
    artSource: artStr(pick(sources, "artSource", "str")),
    banner: str(pick(sources, "banner", "str")),
    synopsis,
    description: synopsis, // stable alias — same value, one vocabulary
    type: normalizeType(pick(sources, "type", "str") || pick(sources, "format", "str")),
    season: str(pick(sources, "season", "str")).toUpperCase(),
    year: num(pick(sources, "year", "num")),
    episodes: num(pick(sources, "episodes", "num")),
    status: normalizeStatus(pick(sources, "status", "str")),
    score: num(pick(sources, "score", "num") ?? pick(sources, "averageScore", "num")),
    rating: str(pick(sources, "rating", "str")),
    genres: arr(pick(sources, "genres", "arr")),
    // v2.6.0 — the merge layer (core/merge.js) carries these in
    // from AniList detail. canonicalAnime doesn't synthesize them
    // when no source provides them; they simply don't appear on
    // browse rows that haven't been merge-enriched yet. Detail
    // surfaces (anime/meta) ALWAYS carry them because their
    // mergeItem() call pulls anilistDetail first.
    duration: num(pick(sources, "duration", "num")),
    averageScore: num(pick(sources, "averageScore", "num")),
    meanScore: num(pick(sources, "meanScore", "num")),
    popularity: num(pick(sources, "popularity", "num")),
    favourites: num(pick(sources, "favourites", "num")),
    studios: arr(pick(sources, "studios", "arr")),
    trailer: pick(sources, "trailer", "str") || null,
    nextAiringEpisode: pick(sources, "nextAiringEpisode", "obj") || null,
    externalLinks: arr(pick(sources, "externalLinks", "arr")),
    // v2.6.0 — when a row has none of (anilistId, malId, slug) it
    // is a "soft row" (a kaze schedule row whose slug was fabricated
    // from a title, for example). The merge layer will still try
    // to anchor it; clients can use this flag to skip seeking.
    _complete: Boolean(anilistId || malId || slug),
  };
  return out;
}

/**
 * The compact anime LIST-ITEM shape — every entry in results[].
 * Used by /api/search, /api/suggestions, /api/filter, /api/genre,
 * /api/type, /api/status, /api/az-list, /api/meta/season,
 * /api/meta/recommendations, /api/meta/trending, seasons and
 * watch-order related entries.
 *
 * Extensions (sub/dub/total/rating/votes/relation/source/…) ride
 * along AFTER the core fields — same names everywhere they appear.
 */
export function animeListItem({ canonical = null, listing = null, mal = null, identity = null, extra = null } = {}) {
  const base = canonicalAnime({ canonical, listing, mal, identity, extra });
  // list items stay lean: drop detail-only art fields. description stays
  // ("" when no source provided it) so the key set is identical on every
  // list item — no key-presence drift between endpoints.
  const { banner, backdrop, logo, ...item } = base;
  return item;
}

/**
 * One normalized episode.
 * v2.3.0: `seriesFallback` is opt-in — the enrichment chain
 * (core/enrich.js) tries upstream → Kitsu → TMDB FIRST and only
 * falls back to the series poster when every provider came up
 * empty (thumbSource: "poster"). A thumbnail that nothing could
 * fill is null explicitly (art null policy), never missing.
 */
export function episodeRecord(ep = {}, { seriesPoster = "", seriesFallback = false } = {}) {
  const thumb = str(ep.thumbnail ?? ep.poster ?? "");
  const resolved = thumb || (seriesFallback ? str(seriesPoster) : "");
  return {
    number: num(ep.number ?? ep.episode),
    title: str(ep.title ?? ""),
    titleJapanese: str(ep.titleJapanese ?? ""),
    thumbnail: resolved === "" ? null : resolved,
    thumbSource: ep.thumbSource ?? (thumb ? "upstream" : seriesFallback && seriesPoster ? "poster" : null),
    aired: str(ep.aired ?? ""),
    filler: Boolean(ep.filler),
    recap: Boolean(ep.recap),
    ...(ep.id !== undefined ? { id: ep.id ?? null } : {}),
    ...(ep.url ? { url: String(ep.url) } : {}),
  };
}

/**
 * Relation-type normalization for seasons/specials/watch-order groups.
 * v2.4.0 — ONE canonical bucket vocabulary across every surface:
 *   prequel sequel sideStory alternative spinoff special ova ona movie
 *   summary parent related
 * (v2.3 used "specials" and a "trending" bucket that leaked upstream
 *  sidebar labels — both are gone; "trending" rows were never relations.)
 * Maps AniList relationType enums, upstream sidebar labels and free text
 * into these buckets. Generic relations (character/other/source/unknown)
 * land in "related" — or, when a format is known, in the format bucket
 * (movie/ova/ona/special) via bucketForRelation().
 */
const RELATION_BUCKETS = [
  "prequel", "sequel", "sideStory", "alternative", "spinoff", "special",
  "ova", "ona", "movie", "summary", "parent", "related",
];

export function normalizeRelation(raw = "") {
  const s = String(raw || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!s) return "related";
  if (RELATION_BUCKETS.includes(s) && s !== "parent") return s;
  if (s === "parent") return "parent";
  if (s === "specials") return "special";
  if (/pre_?quel/.test(s)) return "prequel";
  if (/seq[uə]?el|continuation/.test(s)) return "sequel";
  if (/parent/.test(s)) return "parent";
  if (/spin.?off/.test(s)) return "spinoff";
  if (/special/.test(s)) return "special";
  if (/ova/.test(s)) return "ova";
  if (/ona/.test(s)) return "ona";
  if (/movie|film/.test(s)) return "movie";
  if (/side[_ ]?story/.test(s)) return "sideStory";
  if (/alternat|adapt|remake|source/.test(s)) return "alternative";
  if (/summar|recap/.test(s)) return "summary";
  return "related";
}

/**
 * v2.4.0: relation bucket for an AniList relations edge.
 * Rule (documented in /api/docs):
 *   1. a TYPED relation (prequel/sequel/parent/spinoff/sideStory/
 *      alternative/summary) always wins — it is the source's own
 *      statement about the pair;
 *   2. generic relations (character/other/source/unknown) fall back to
 *      the node's FORMAT (movie/ova/ona/special) so a stray movie still
 *      lands in the movie bucket instead of polluting everything;
 *   3. otherwise "related".
 */
export function bucketForRelation(relationType = "", format = "") {
  const rt = normalizeRelation(relationType);
  if (rt !== "related") return rt;
  const fmt = normalizeType(format);
  if (/^movie$/i.test(fmt)) return "movie";
  if (/^ova$/i.test(fmt)) return "ova";
  if (/^ona$/i.test(fmt)) return "ona";
  if (/^special/i.test(fmt)) return "special";
  return "related";
}

/** Group related entries into the canonical relation buckets. */
export function groupRelations(entries = []) {
  const groups = {};
  for (const e of entries) {
    const bucket = normalizeRelation(e.relation || e.relationType);
    (groups[bucket] ||= []).push(e);
  }
  return groups;
}

/** Canonical bucket order for watch-order sequencing and stable group keys. */
export const RELATION_ORDER = [
  "prequel", "parent", "sequel", "sideStory", "spinoff", "movie",
  "ova", "ona", "special", "summary", "alternative", "related",
];

/**
 * Group a flat related/seasons list into the shared relation shape used
 * by /api/seasons, /api/watch-order and any detail `relations` block:
 *   { entries: [...unified items...], groups: { sequel: [...], ... } }
 */
export function relationsBlock(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    entries: list,
    groups: groupRelations(list),
    counts: Object.fromEntries(Object.entries(groupRelations(list)).map(([k, v]) => [k, v.length])),
  };
}
