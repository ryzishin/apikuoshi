/**
 * ============================================================
 *  APIKuoshi — src/core/keys.js                       v2.2.0
 * ============================================================
 *  Identity resolution shared by every endpoint and the /api/chain
 *  streaming pipeline.
 *
 *  A "key" identifies one anime. ANY of these must resolve:
 *    anilist:<id>   AniList id              e.g. anilist:154587
 *    mal:<id>       MyAnimeList id          e.g. mal:52991
 *    <number>       treated as an AniList id
 *    <slug>         a listing slug          e.g. frieren-odmau
 *    <title>        romaji / english / native / synonym — ANY
 *                   spelling, punctuation included ("Frieren:
 *                   Beyond Journey's End" resolves; colons are
 *                   no longer mistaken for key prefixes).
 *
 *  AniList is an ANCHOR, not a REQUIREMENT. When AniList is
 *  unreachable the resolver degrades gracefully: MAL-only
 *  identities (mal:<id>) and slug-only identities keep working,
 *  so every endpoint that fetches listings/episodes/servers
 *  keeps serving data.
 *
 *  resolveIdentity() returns { anilistId, malId, slug, title, via }
 *  — any subset is valid; canonicalFor() turns it into a full
 *  canonical entry using whichever sources are reachable.
 * ============================================================
 */
import {
  anilistSearch, anilistById,
} from "./anilist.js";
import { getLane } from "./registry.js";
import { CustomError } from "./errors.js";
import config from "../config.js";
import { cleanListingSlug, titleFromSlug, looksLikeListingSlug, titleSlug } from "./shape.js";
import { withCache } from "./cache.js";

/** Public key string for an AniList id (legacy helper — prefer keyForIds). */
export const keyFor = (anilistId) => (anilistId ? `anilist:${anilistId}` : null);

/**
 * Normalize a user-supplied title for AniList search.
 * AniList's tokenizer treats "Goodbye," (comma glued to a word) as a
 * junk token, so "Goodbye, Lara" finds nothing while "goodbye lara"
 * finds the show. Turn punctuation into a space, collapse whitespace,
 * lowercase — so comma and space become interchangeable.
 */
function normalizeTitleQuery(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[,:;!?."'()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** AniList search with one retry — the shared outbound IP occasionally
 *  gets a transient 429/timeout; one short retry saves the request.
 *  Returns up to `perPage` candidates; callers should pick the best by
 *  title similarity instead of trusting upstream ranking order. */
async function anilistSearchSteady(q, perPage = 5) {
  let first = await anilistSearch(q, perPage);
  if (!first.length) {
    await new Promise((r) => setTimeout(r, 400));
    first = await anilistSearch(q, perPage);
  }
  return first;
}

/**
 * Anchor a title to an AniList entry. RANKS candidates by title similarity
 * (romaji / english / native / synonyms) instead of trusting upstream
 * SEARCH_MATCH order — with perPage=1, spin-offs and mini-animes that
 * merely share tokens could hijack the anchor.
 * v2.2.1: ties are broken by EXACT normalized-title equality, so when a
 * search for "Steins;Gate 0" returns the original series first (it used to
 * score an identical 100), the exact spelling always wins the tie.
 * Returns anilistId|null. Never throws.
 */
async function anchorTitleToAnilist(title) {
  if (!title) return null;
  const { titleSimilarity, pickBestBySimilarity } = await import("./titles.js");
  const attempts = Array.from(new Set([title, normalizeTitleQuery(title)].filter(Boolean)));
  let bestId = null;
  let bestScore = 0;
  for (const q of attempts) {
    const found = await anilistSearchSteady(q, 5);
    const { best, score } = pickBestBySimilarity(title, found, (c) => Math.max(
      titleSimilarity(title, c.titleRomaji || ""),
      titleSimilarity(title, c.titleEnglish || ""),
      titleSimilarity(title, c.title || ""),
      ...(c.synonyms || []).map((s) => titleSimilarity(title, s))
    ));
    // keep the cross-attempt best (attempts are "raw title" then "normalized")
    if (best && score > bestScore) { bestScore = score; bestId = best.anilistId; }
    if (bestId && bestScore >= 85) break; // confident enough
  }
  return bestId;
}

/**
 * Resolve a listing slug to an identity:
 *   1. the listing page itself (kaze.info) — the AUTHORITATIVE title for
 *      that slug; prevents mis-anchoring when search ranking buries the
 *      exact listing
 *   2. kaze search seeded by the de-slugged title — exact listingId match
 *      wins, best title match is the fallback
 *   3. anchor the listing's title to AniList
 *   4. if AniList is down, the SLUG ITSELF is the identity — the kaze lane
 *      can still serve info/episodes/servers for it.
 */
async function resolveSlugIdentity(rawSlug) {
  const slug = cleanListingSlug(rawSlug);
  const kaze = getLane("kaze");

  // memoize successful resolutions for a short window (per-process)
  return withCache(`slugid:${slug}`, 300, async () => {
    let listingTitle = null;

    // 1. the listing page is authoritative
    if (kaze) {
      try {
        const info = await kaze.info(slug);
        if (info?.title) listingTitle = info.title;
      } catch { /* slug may not exist as a listing — try search */ }
    }

    // 2. search seeded by the de-slugged title — exact listingId match wins;
    //    otherwise rank by slug-token overlap so a spin-off that merely
    //    shares one token can never hijack the anchor
    if (!listingTitle && kaze) {
      try {
        const seed = titleFromSlug(slug);
        const seedTokens = new Set(seed.split(/\s+/).filter(Boolean));
        const results = (await kaze.search(seed, 1)) || [];
        const exact = results.find((r) => cleanListingSlug(r.listingId) === slug);
        const ranked = results
          .map((r) => {
            const tokens = String(r.title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            const overlap = tokens.filter((t) => seedTokens.has(t)).length / (seedTokens.size || 1);
            return { r, overlap };
          })
          .sort((a, b) => b.overlap - a.overlap);
        const best = exact || ranked[0]?.r || null;
        if (best?.title) listingTitle = best.title;
      } catch { /* kaze unreachable — continue */ }
    }

    const anilistId = listingTitle ? await anchorTitleToAnilist(listingTitle) : null;
    return { anilistId, malId: null, slug, title: listingTitle || "", via: "slug" };
  });
}

/**
 * THE RESOLVER. Any public key -> { anilistId, malId, slug, title, via }.
 * Every field is optional except at least one identifier.
 * Throws CustomError(400/404) only when NOTHING can be derived.
 */
export async function resolveIdentity(key) {
  if (!key) {
    throw new CustomError(
      "Provide ?key= (anilist:<id> | mal:<id> | <id> | <slug> | <title>)",
      400
    );
  }
  const s = String(key).trim();

  // --- explicit prefixed keys -------------------------------------------
  if (/^anilist:\d+$/i.test(s)) {
    return { anilistId: parseInt(s.split(":")[1], 10), malId: null, slug: "", title: "", via: "anilist-key" };
  }
  if (/^mal:\d+$/i.test(s)) {
    const malId = parseInt(s.split(":")[1], 10);
    const ishi = getLane("ishi");
    const alId = ishi ? await ishi.malToAnilist(malId).catch(() => null) : null;
    if (alId) return { anilistId: alId, malId, slug: "", title: "", via: "mal-key" };
    // AniList mapping unavailable — the MAL id IS the identity.
    return { anilistId: null, malId, slug: "", title: "", via: "mal-only" };
  }
  if (/^(anilist|mal):/i.test(s)) {
    throw new CustomError(`Malformed key "${s}" — expected anilist:<number> or mal:<number>`, 400);
  }

  // --- bare number = AniList id ------------------------------------------
  if (/^\d+$/.test(s)) {
    return { anilistId: parseInt(s, 10), malId: null, slug: "", title: "", via: "numeric" };
  }

  // --- listing slug --------------------------------------------------------
  // (checked BEFORE the colon fallthrough so "frieren-odmau/ep-3" style
  //  inputs and kebab slugs resolve; plain titles still win below.)
  if (looksLikeListingSlug(s)) {
    const bySlug = await resolveSlugIdentity(s);
    if (bySlug.anilistId || bySlug.slug) return bySlug;
  }

  // --- plain title (romaji / english / native / synonym) -------------------
  // Colon-bearing titles ("Frieren: Beyond Journey's End", "Re:Zero") were
  // previously rejected here as "unknown key format" — they are titles.
  const anilistId = await anchorTitleToAnilist(s);
  if (anilistId) return { anilistId, malId: null, slug: "", title: s, via: "title" };

  // AniList could not anchor it — maybe the phrase matches a listing on
  // the kaze lane (returns a slug identity that still serves episodes).
  const kaze = getLane("kaze");
  if (kaze) {
    try {
      const results = (await kaze.search(s, 1)) || [];
      if (results.length) {
        // v2.2.1: rank by similarity with an exact-title tie-break instead of
        // blindly trusting results[0] — upstream order put "Steins;Gate 0"
        // ahead of "Steins;Gate" for both spellings.
        const { titleSimilarity, pickBestBySimilarity } = await import("./titles.js");
        const { best } = pickBestBySimilarity(s, results, (r) => Math.max(
          titleSimilarity(r.title, s),
          r.titleAlt ? titleSimilarity(r.titleAlt, s) : 0
        ));
        const picked = best || results[0];
        const anchored = picked.title ? await anchorTitleToAnilist(picked.title) : null;
        return {
          anilistId: anchored,
          malId: picked.malId ?? null,
          slug: cleanListingSlug(picked.listingId) || titleSlug(picked.title),
          title: picked.title || s,
          via: "kaze-fallback",
        };
      }
    } catch { /* kaze unreachable too */ }
  }

  // Last resort: a well-formed slug-ish input still yields a slug identity.
  if (looksLikeListingSlug(s)) {
    return { anilistId: null, malId: null, slug: cleanListingSlug(s), title: titleFromSlug(s), via: "slug-only" };
  }

  throw new CustomError(`No anime found for title "${s}"`, 404);
}

/**
 * Legacy helper kept for compatibility: resolve any key to an AniList id.
 * NOTE: may now return null for legitimately slug-only / mal-only inputs
 * (AniList unreachable) — callers must handle null; canonicalFor is the
 * preferred entry point.
 */
export async function resolveKeyToAnilist(key) {
  const id = await resolveIdentity(key);
  if (id.anilistId) return id.anilistId;
  throw new CustomError(
    `Could not anchor "${key}" to an AniList id (AniList unreachable or unknown anime)`,
    404
  );
}

/**
 * Best title-match for slug-keyed content against the canonical entry.
 * Used internally to map a canonical anime onto a playable listing.
 * Accepts an optional `preferredSlug` — an exact listingId hit wins.
 */
export async function matchSlug(lane, canonical, preferredSlug = null) {
  const { titleSimilarity, pickBestBySimilarity } = await import("./titles.js");

  if (preferredSlug) {
    const want = cleanListingSlug(preferredSlug);
    try {
      const seed = titleFromSlug(want) || canonical?.titleRomaji || canonical?.title || "";
      const results = await lane.search(seed, 1);
      const exact = (results || []).find((r) => cleanListingSlug(r.listingId) === want);
      if (exact) {
        return { listingId: cleanListingSlug(exact.listingId), title: exact.title, matchScore: 100 };
      }
    } catch { /* fall through to similarity match */ }
  }

  const query =
    canonical?.titleRomaji || canonical?.title || titleFromSlug(preferredSlug || "") ||
    String(canonical?.anilistId || "");
  if (!query) return null;
  const results = await lane.search(query);
  const { best: bestWrap, score } = pickBestBySimilarity(query, results || [], (r) => Math.max(
    titleSimilarity(r.title, canonical?.titleRomaji || canonical?.title || ""),
    titleSimilarity(r.title, canonical?.titleEnglish || ""),
    r.titleAlt ? titleSimilarity(r.titleAlt, canonical?.titleRomaji || canonical?.title || "") : 0
  ));
  if (!bestWrap || score < config.dedupThreshold) return null;
  return { listingId: cleanListingSlug(bestWrap.listingId), title: bestWrap.title, matchScore: score };
}

/**
 * Canonical entry for any key — DEGRADATION-AWARE.
 * Returns { anilistId, malId, slug, canonical, via } where `canonical`
 * is the richest identity object reachable right now:
 *   1. AniList entry (normal path)
 *   2. AniList down  -> internal identity mapper cache (title/malId)
 *   3. MAL-only      -> MAL details scrape
 *   4. slug-only     -> kaze listing info
 * Never throws when the anime itself is known — only 400/404 when the
 * input cannot be understood at all.
 */
export async function canonicalFor(key) {
  const identity = await resolveIdentity(key);
  const { anilistId, malId, slug, title, via } = identity;

  let canonical = null;

  if (anilistId) {
    canonical = await anilistById(anilistId);
    if (!canonical) {
      // AniList outage — degrade instead of failing the whole endpoint.
      canonical = await degradedCanonical({ anilistId, malId, slug, title });
    }
  } else if (malId) {
    canonical = await malCanonical(malId);
    if (!canonical) {
      throw new CustomError(`Anime not found (mal:${malId})`, 404);
    }
  } else if (slug) {
    canonical = await slugCanonical(slug, title);
    if (!canonical) {
      throw new CustomError(
        `No listing or metadata found for slug "${slug}" — it may not exist in the catalog`,
        404
      );
    }
  }

  if (!canonical) {
    throw new CustomError("Could not load metadata for this anime", 502);
  }

  return {
    anilistId: canonical.anilistId ?? anilistId ?? null,
    malId: canonical.malId ?? malId ?? null,
    // a real listing slug (from the resolver) beats a title-derived slug
    slug: identity.slug || canonical.slug || "",
    canonical,
    via,
  };
}

/** Build a minimal-but-honest canonical entry when AniList is unreachable. */
async function degradedCanonical({ anilistId, malId, slug, title }) {
  // 1. the internal identity mapper keeps its own cached title/malId
  try {
    const { getSiteIds } = await import("../sources/ishi/dist/utils/mapper.js");
    const site = await getSiteIds(anilistId);
    if (site && site.title && site.title !== "Unknown") {
      return {
        anilistId,
        malId: site.malId ?? malId ?? null,
        slug: slug || "",
        title: site.title,
        titleRomaji: site.altTitle || site.title,
        titleEnglish: site.altTitle ? site.title : "",
        titleNative: "",
        synonyms: [],
        episodes: null,
        format: null,
        status: null,
        year: null,
        poster: "",
        banner: null,
        degraded: true,
      };
    }
  } catch { /* mapper offline */ }

  // 2. MAL details if a malId is known
  if (malId) {
    const c = await malCanonical(malId);
    if (c) return { ...c, anilistId: c.anilistId ?? anilistId, degraded: true };
  }

  // 3. whatever the resolver itself derived
  if (title || slug) {
    return {
      anilistId: anilistId ?? null,
      malId: malId ?? null,
      slug: slug || "",
      title: title || titleFromSlug(slug),
      titleRomaji: title || "",
      titleEnglish: "",
      titleNative: "",
      synonyms: [],
      episodes: null,
      format: null,
      status: null,
      year: null,
      poster: "",
      banner: null,
      degraded: true,
    };
  }
  return null;
}

/** MAL-only canonical entry (AniList-free). */
async function malCanonical(malId) {
  try {
    const ishi = getLane("ishi");
    if (!ishi?.malDetails) return null;
    const details = await ishi.malDetails(parseInt(malId, 10));
    if (!details) return null;
    return {
      anilistId: null,
      malId,
      slug: "",
      title: details.title || details.titleEnglish || "",
      titleRomaji: details.title || "",
      titleEnglish: details.titleEnglish || "",
      titleNative: details.titleJapanese || "",
      synonyms: [],
      episodes: details.episodes ?? null,
      format: details.type || null,
      status: details.status || null,
      year: details.aired?.match(/\d{4}/)?.[0] ? parseInt(details.aired.match(/\d{4}/)[0], 10) : null,
      poster: details.image || "",
      banner: null,
      degraded: true,
    };
  } catch {
    return null;
  }
}

/** Slug-only canonical entry from the kaze listing itself. */
async function slugCanonical(slug, knownTitle) {
  try {
    const kaze = getLane("kaze");
    if (!kaze) return null;
    const info = await kaze.info(slug);
    if (!info?.title) return null;
    const anchored = knownTitle || info.title ? await anchorTitleToAnilist(info.title) : null;
    const alEntry = anchored ? await anilistById(anchored) : null;
    return {
      anilistId: alEntry?.anilistId ?? null,
      malId: alEntry?.malId ?? null,
      slug,
      title: info.title,
      titleRomaji: info.titleAlt || alEntry?.titleRomaji || info.title,
      titleEnglish: alEntry?.titleEnglish || "",
      titleNative: alEntry?.titleNative || "",
      synonyms: alEntry?.synonyms || [],
      episodes: info.episodes ?? alEntry?.episodes ?? null,
      format: info.type || alEntry?.format || null,
      status: info.status || alEntry?.status || null,
      year: alEntry?.year ?? null,
      poster: info.poster || alEntry?.poster || "",
      banner: alEntry?.banner ?? null,
      degraded: !alEntry,
    };
  } catch {
    return null;
  }
}
