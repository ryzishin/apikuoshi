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
import { withCache, cacheGet, cacheSet } from "./cache.js";
import { rememberAnime, lookupAnime } from "./identity.js";

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
  // v2.4.0: add an apostrophe-GLUED variant — "Koala's Diary" searched as
  // "koala s diary" finds nothing (the lone "s" poisons AniList matching,
  // same failure mode as junk slug tokens); "koalas diary" finds it.
  const glued = String(title).toLowerCase().replace(/[’'"\u2019]/g, "").replace(/[,:;!?"()\[\]{}]/g, " ").replace(/\s+/g, " ").trim();
  const attempts = Array.from(new Set([title, normalizeTitleQuery(title), glued].filter(Boolean)));
  let bestId = null;
  let bestScore = 0;
  for (const q of attempts) {
    const found = await anilistSearchSteady(q, 5);
    // v2.5.1: titleNative joins the scorer — a native/CJK input (葬送のフリーレン)
    // scored ~0 against romaji/English candidate titles alone, so AniList's
    // raw SearchMatch order decided and spin-offs/mini-animes hijacked the
    // anchor. Comparing against the candidate's NATIVE title too lets the
    // exact spelling win (main series 154587 instead of a mini anime).
    const { best, score } = pickBestBySimilarity(title, found, (c) => Math.max(
      titleSimilarity(title, c.titleRomaji || ""),
      titleSimilarity(title, c.titleEnglish || ""),
      titleSimilarity(title, c.title || ""),
      titleSimilarity(title, c.titleNative || ""),
      ...(c.synonyms || []).map((s) => titleSimilarity(title, s))
    ));
    // keep the cross-attempt best (attempts are "raw title" then "normalized")
    if (best && score > bestScore) { bestScore = score; bestId = best.anilistId; }
    if (bestId && bestScore >= 85) break; // confident enough
  }
  return bestId;
}

/**
 * v2.4.0: quiet variant for the identity backfill queue — same anchoring,
 * but gated by the dedup threshold so background work can never mis-anchor
 * a row (foreground resolution stays as permissive as v2.3).
 */
export async function anchorTitleToAnilistQuiet(title) {
  try {
    const { titleSimilarity, pickBestBySimilarity } = await import("./titles.js");
    const glued = String(title).toLowerCase().replace(/[’'"\u2019]/g, "").replace(/[,:;!?"()\[\]{}]/g, " ").replace(/\s+/g, " ").trim();
    const attempts = Array.from(new Set([normalizeTitleQuery(title), glued].filter(Boolean)));
    let bestPick = null;
    for (const q of attempts) {
      const found = await anilistSearchSteady(q, 5);
      // v2.5.1: titleNative in the scorer here too — background backfill
      // must not mis-anchor native-title rows the foreground now resolves.
      const { best, score } = pickBestBySimilarity(title, found, (c) => Math.max(
        titleSimilarity(title, c.titleRomaji || ""),
        titleSimilarity(title, c.titleEnglish || ""),
        titleSimilarity(title, c.title || ""),
        titleSimilarity(title, c.titleNative || "")
      ));
      if (best && (!bestPick || score > bestPick.score)) bestPick = { best, score };
      if (bestPick && bestPick.score >= (config.dedupThreshold || 78)) break;
    }
    return bestPick && bestPick.score >= (config.dedupThreshold || 78) ? bestPick.best.anilistId : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a listing slug to an identity:
 *   0. the shared identity index (v2.4.0) — instant when ANY endpoint of
 *      this process already resolved the slug or its title
 *   1. the listing page itself (kaze.info) — the AUTHORITATIVE title for
 *      that slug; prevents mis-anchoring when search ranking buries the
 *      exact listing
 *   2. kaze search seeded by the de-slugged title — exact listingId match
 *      wins, best title match is the fallback
 *   3. v2.4.0 SLUG-REPAIR: upstream discovery pages keep stale slugs whose
 *      watch pages are gone (e.g. "frieren-odmau" — /watch/ 404s while
 *      search carries "frieren-beyond-journey-s-end-c6fbj"). The raw
 *      de-slugged seed contains junk tokens ("odmau", "4hk9h") that empty
 *      the search. Retry with progressively shortened seeds so a stale
 *      slug still resolves to the anime it belongs to.
 *   4. anchor the listing's title to AniList
 *   5. if AniList is down, the SLUG ITSELF is the identity — the kaze lane
 *      can still serve info/episodes/servers for it.
 */
async function resolveSlugIdentity(rawSlug) {
  const slug = cleanListingSlug(rawSlug);
  const kaze = getLane("kaze");

  // v2.4.0: 0. shared identity index — zero upstream calls
  const known = lookupAnime({ slug });
  if (known?.anilistId) {
    return {
      anilistId: known.anilistId,
      malId: known.malId ?? null,
      slug,
      title: known.title || "",
      via: "identity-index",
    };
  }

  // memoize successful resolutions (per-process); negative results are
  // cached for only 45 s so a transient upstream failure cannot poison
  // slug resolution for the full window (v2.4.0 fix)
  const cacheKey = `slugid:${slug.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const identity = await (async () => {
    let listingTitle = null;
    let listingSlug = slug;
    let anchoredId = null;
    let bestPick = null;

    // 1. the listing page is authoritative
    if (kaze) {
      try {
        const info = await kaze.info(slug);
        if (info?.title) {
          listingTitle = info.title;
          // v2.4.0: kaze.info also feeds the index (poster/type/episodes)
          rememberAnime({ ...info, slug, listingSlug: slug });
        }
      } catch { /* slug may not exist as a listing — try search */ }
    }

    // 2+3. search — full seed first, then slug-repair shortening
    if (!listingTitle && kaze) {
      const seed = titleFromSlug(slug);
      const seedTokens = new Set(seed.split(/\s+/).filter(Boolean));
      const { titleSimilarity } = await import("./titles.js");
      const wantTitle = canonicalTitleFor(slug, known);

      const trySeeds = [seed];
      const tokens = seed.split(/\s+/).filter(Boolean);
      // slug-repair: drop trailing tokens one by one (max 3 attempts) —
      // site-unique suffixes ("odmau", "4hk9h") poison upstream search
      for (let drop = 1; drop <= Math.min(3, tokens.length - 1); drop++) {
        const shortened = tokens.slice(0, tokens.length - drop).join(" ").trim();
        if (shortened && shortened.split(/\s+/).length >= Math.max(1, tokens.length - drop)) {
          trySeeds.push(shortened);
        }
      }

      for (const candidate of trySeeds) {
        let results = [];
        try {
          results = (await kaze.search(candidate, 1)) || [];
        } catch { /* kaze unreachable — continue */ }
        if (!results.length) continue;

        const exact = results.find((r) => cleanListingSlug(r.listingId) === slug);
        if (exact?.title) {
          listingTitle = exact.title;
          listingSlug = cleanListingSlug(exact.listingId) || slug;
          break;
        }

        // v2.4.0: anchor the TOP candidates, not just the first ranked row —
        // upstream search is fuzzy, so a spin-off/mini-anime that merely
        // shares tokens can outrank the main series; its over-specific title
        // then fails to anchor and the whole identity was lost. Try each of
        // the top rows, keep the anchor whose title best matches the
        // franchise query (short sane titles win over decorated ones).
        const { pickBestBySimilarity } = await import("./titles.js");
        const ranked = results
          .map((r) => {
            const tokens2 = String(r.title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            const overlap = tokens2.filter((t) => seedTokens.has(t)).length / (seedTokens.size || 1);
            // penalize candidates whose season decoration disagrees with the slug
            const penalty = seasonDecoration(r.title) !== seasonDecoration(slug) ? 8 : 0;
            return { r, overlap, sim: titleSimilarity(r.title, wantTitle) - penalty };
          })
          .sort((a, b) => b.sim - a.sim || b.overlap - a.overlap)
          .slice(0, 3);

        for (const { r } of ranked) {
          if (!r?.title) continue;
          const anchored = await anchorTitleToAnilist(r.title);
          if (!anchored) continue;
          const al = await anilistById(anchored).catch(() => null);
          const penalty = seasonDecoration(r.title) !== seasonDecoration(slug) ? 8 : 0;
          const score = Math.max(
            titleSimilarity(r.title, wantTitle),
            al ? Math.max(
              titleSimilarity(al.titleRomaji || "", wantTitle),
              titleSimilarity(al.titleEnglish || "", wantTitle)
            ) : 0
          ) - penalty;
          if (!bestPick || score > bestPick.score) {
            bestPick = { row: r, anilistId: anchored, score };
          }
          if (bestPick.score >= 85) break; // confident enough
        }
        if (bestPick) {
          listingTitle = bestPick.row.title;
          listingSlug = cleanListingSlug(bestPick.row.listingId) || slug;
          anchoredId = bestPick.anilistId;
          // v2.4.0: remember the repair — stale slug now maps to the live
          // listing + the canonical identity
          if (listingSlug !== slug) {
            rememberAnime({ slug, title: listingTitle, listingSlug, anilistId: anchoredId });
          }
          break;
        }
      }
    }

    // v2.4.0: the anchor found during slug-repair wins — no re-anchoring
    const anilistId = anchoredId ?? (listingTitle ? await anchorTitleToAnilist(listingTitle) : null);
    return { anilistId, malId: null, slug, title: listingTitle || "", via: "slug", listingSlug };
  })();

  cacheSet(cacheKey, identity, identity.anilistId ? 300 : 45);
  if (identity.anilistId) {
    // v2.4.0: every successful slug resolution feeds the shared index
    rememberAnime({
      anilistId: identity.anilistId,
      slug,
      listingSlug: identity.listingSlug || slug,
      title: identity.title,
    });
  }
  return identity;
}

/** Best-known title for a slug (index first, de-slugged seed fallback). */
function canonicalTitleFor(slug, known) {
  if (known?.title) return known.title;
  const fromSlug = titleFromSlug(slug);
  // drop the trailing junk token when it looks site-generated (5+ chars of
  // consonant soup or hex-ish suffix: "odmau", "4hk9h", "8sbwi")
  const tokens = fromSlug.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (/^[a-z0-9]{4,6}$/i.test(last) && /\d/.test(last) === false && /^[^aeiou]{0,2}[a-z0-9]{3,}$/i.test(last)) {
      return tokens.slice(0, -1).join(" ");
    }
  }
  return fromSlug;
}

/**
 * v2.4.0: season/sequel decoration detector ("Season 2", "2nd", "III",
 * "Part 2", "Final"). When the requested slug carries no decoration but a
 * search candidate does (or vice versa), that candidate is penalized —
 * a bare legacy slug like "frieren-odmau" must not resolve to a
 * decorated sequel whose title merely shares the franchise tokens.
 */
function seasonDecoration(text = "") {
  return /season\s*\d|\d(?:st|nd|rd|th)\s*season|\b(?:ii|iii|iv|v)\b|part\s*\d|\bcour\b|\bfinal\b/i.test(String(text)) ? 1 : 0;
}

/**
 * v2.5.1: extract an identity from a pasted URL, or null when the string
 * is not a usable http(s) URL. Recognized:
 *   https://anilist.co/anime/154587            -> { anilistId: 154587 }
 *   https://anilist.co/anime/Sousou-no-Frieren-154587 -> id from the tail
 *   https://myanimelist.net/anime/50265[...]   -> { malId: 50265 }
 *   https://<any host>/watch/<slug>[/...]      -> { slug }
 *   https://<any host>/anime/<slug>[...]       -> { slug } (non-numeric only)
 *   https://<any host>/title/<slug> | /series/<slug> -> { slug }
 */
export function keyFromUrl(s) {
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  // metadata-site URLs carry the numeric id directly
  if (/anilist\.co$/i.test(u.hostname)) {
    const i = parts.indexOf("anime");
    const seg = i >= 0 ? parts[i + 1] : "";
    const m = seg ? /(\d+)\s*$/.exec(seg) : null;
    if (m) return { anilistId: parseInt(m[1], 10) };
  }
  if (/myanimelist\.net$/i.test(u.hostname)) {
    const i = parts.indexOf("anime");
    const seg = i >= 0 ? parts[i + 1] : "";
    if (/^\d+/.test(seg || "")) return { malId: parseInt(seg, 10) };
  }

  // watch-site URLs — the segment after a known marker is the listing slug
  // (numeric-only segments are AniList-style ids of unknown sites; skip
  //  those rather than feed a bare number into the slug ladder)
  for (const marker of ["watch", "anime", "title", "series"]) {
    const i = parts.indexOf(marker);
    const seg = i >= 0 ? parts[i + 1] : "";
    if (seg && seg.length > 2 && !/^\d+$/.test(seg)) return { slug: seg };
  }
  return null;
}

/**
 * THE RESOLVER. Any public key -> { anilistId, malId, slug, title, via }.
 * Every field is optional except at least one identifier.
 * Throws CustomError(400/404) only when NOTHING can be derived.
 *
 * v2.5.1 — accepted key formats:
 *   anilist:<id> | mal:<id> | slug:<slug> | <numeric id> | <slug> | <title>
 *   https://anilist.co/anime/<id> | https://myanimelist.net/anime/<id>
 *   https://<watch-site>/watch/<slug> (any catalog URL with a slug segment)
 */
export async function resolveIdentity(key) {
  if (!key) {
    throw new CustomError(
      "Provide ?key= (anilist:<id> | mal:<id> | slug:<slug> | <id> | <slug> | <title> | <url>)",
      400
    );
  }
  const s = String(key).trim();

  // --- pasted URLs (v2.5.1) ----------------------------------------------
  // anilist.co/anime/154587, myanimelist.net/anime/50265 and any watch-site
  // URL whose path carries the listing slug resolve to their canonical key
  // form and recurse — one parser, no duplicated ladders.
  const fromUrl = keyFromUrl(s);
  if (fromUrl) {
    if (fromUrl.anilistId) return resolveIdentity(`anilist:${fromUrl.anilistId}`);
    if (fromUrl.malId) return resolveIdentity(`mal:${fromUrl.malId}`);
    if (fromUrl.slug) return resolveIdentity(`slug:${fromUrl.slug}`);
  }

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

  // --- explicit slug: prefix (v2.5.1) -------------------------------------
  // "slug:frieren-beyond-journeys-end" previously fell through every format
  // check and died as a 404 "title" — the prefix is now stripped and the
  // rest takes the exact slug ladder. Non-slug content after the prefix
  // (defensive: "slug:154587", "slug:Frieren") re-enters the resolver with
  // the stripped value so numbers still hit the id path and phrases the
  // title path — without the "slug:" junk token polluting the query.
  if (/^slug:/i.test(s)) {
    const slugPart = s.slice(5).trim().replace(/^\/+|\/+$/g, "");
    if (looksLikeListingSlug(slugPart)) {
      const bySlug = await resolveSlugIdentity(slugPart);
      if (bySlug.anilistId || bySlug.slug) return bySlug;
    } else if (slugPart) {
      return resolveIdentity(slugPart);
    }
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
 * v2.5.0 — FLEXIBLE IDENTITY RESOLUTION (the silent fallback ladder).
 *
 * canonicalFor() is the honest resolver: it succeeds when the identity is
 * reachable RIGHT NOW and fails when it is not. The problem: anilist/mal
 * ids are not always indexed (AniList outage, rate limit, mapper cache
 * cold, upstream catalog gaps), while the LISTING SLUG — the one address
 * the upstream catalog itself understands — keeps working. Callers that
 * would 404/502 on a dead id key can instead climb this ladder:
 *
 *   1. canonicalFor(key)                          — the normal path
 *   2. the shared identity index (by id)          — slug/title the system
 *                                                   already knows
 *   3. the ishi mapper (anilistId → malId/title)  — MAL details scrape
 *   4. the anchored title → kaze slug identity    — upstream always wins
 *                                                   for slugs
 *
 * Same signature as canonicalFor; only 404/502-class failures are
 * retried (bad input still fails fast with its original error).
 */
export async function resolveFlexible(key, { advanced = false } = {}) {
  // v2.6.0 — `advanced: true` (or the caller passes a key that the
  // foreground canonicalFor already failed on) climbs a longer
  // ladder: getSiteIdsByMal for mal: keys, kaze.search(title) for
  // any unanchored id, multi-variant title search (romaji/english/
  // native/synonyms) for plain titles. Backfill is enqueued on
  // every miss so the NEXT request resolves instantly.
  try {
    return await canonicalFor(key);
  } catch (err) {
    const status = err?.status || 500;
    if (![404, 502].includes(status)) throw err;
    const rescued = await flexibleIdentityLadder(String(key || "").trim(), { advanced });
    if (rescued) return rescued;
    // v2.6.0 — last-ditch: enqueue backfill so the next request
    // succeeds. The current response still throws the original
    // 404/502 so the client gets an honest signal that this key
    // is genuinely unknown to the system right now.
    if (advanced) {
      const titleGuess = String(key || "").replace(/^(anilist|mal|slug):/i, "").replace(/[_+]/g, " ").trim();
      if (titleGuess && titleGuess.length >= 2) {
        queueIdentityBackfill({ slug: looksLikeListingSlug(titleGuess) ? cleanListingSlug(titleGuess) : "", title: titleGuess });
      }
    }
    throw err;
  }
}

/** v2.6.0 — Ladder steps 2-6. Returns canonicalFor-shaped data or null. */
async function flexibleIdentityLadder(key, { advanced = false } = {}) {
  if (!key) return null;
  const s = key;

  // --- id-shaped keys: mine every mapper/index for a title or slug ------
  const anilistId = /^anilist:(\d+)$/i.exec(s)?.[1] || (/^\d+$/.test(s) ? s : null);
  const malIdRaw = /^mal:(\d+)$/i.exec(s)?.[1] || null;

  if (anilistId || malIdRaw) {
    const alId = anilistId ? parseInt(anilistId, 10) : null;
    const malId = malIdRaw ? parseInt(malIdRaw, 10) : null;

    // 2. shared identity index — anything ANY endpoint of this process
    //    already resolved about this anime (slug ALWAYS resolvable)
    const known = lookupAnime({ anilistId: alId, malId });
    if (known?.slug) {
      try { return await canonicalFor(known.slug); } catch { /* keep climbing */ }
    }
    if (known?.title) {
      try { return await canonicalFor(known.title); } catch { /* keep climbing */ }
    }

    // 3a. ishi mapper — anilistId → { malId, title }
    try {
      const { getSiteIds } = await import("../sources/ishi/dist/utils/mapper.js");
      const site = alId ? await getSiteIds(alId).catch(() => null) : null;
      const siteMal = malId ?? (site?.malId ? parseInt(site.malId, 10) : null);
      if (siteMal) {
        const c = await malCanonical(siteMal);
        if (c) {
          return {
            anilistId: c.anilistId ?? alId,
            malId: c.malId ?? siteMal,
            slug: c.slug || "",
            canonical: c,
            via: "flexible-mapper",
          };
        }
      }
      const siteTitle = site?.title && site.title !== "Unknown" ? site.title : null;
      if (siteTitle) {
        try { return await canonicalFor(siteTitle); } catch { /* keep climbing */ }
      }
    } catch { /* mapper offline */ }

    // 3b. v2.6.0 — ishi mapper REVERSE: malId → { anilistId, title }.
    // The ishi adapter exposes getSiteIdsByMal but the v2.5.2 ladder
    // never called it. Closes the "pure mal: key that the index
    // doesn't know" hole.
    if (malId && advanced) {
      try {
        const { getSiteIdsByMal } = await import("../sources/ishi/dist/utils/mapper.js");
        if (typeof getSiteIdsByMal === "function") {
          const malSite = await getSiteIdsByMal(malId).catch(() => null);
          const siteAl = malSite?.anilistId ? parseInt(malSite.anilistId, 10) || null : null;
          if (siteAl) {
            try { return await canonicalFor("anilist:" + siteAl); } catch { /* keep climbing */ }
          }
          const siteTitle = malSite?.title && malSite.title !== "Unknown" ? malSite.title : null;
          if (siteTitle) {
            try { return await canonicalFor(siteTitle); } catch { /* keep climbing */ }
          }
        }
      } catch { /* mapper or reverse-mapper offline */ }
    }

    // 4. v2.6.0 — kaze.search(title) when both ids failed. We use
    // the title from the index if available, or the raw key string
    // (stripped of prefix) as a last-resort query. The result is
    // title-anchored through `anchorTitleToAnilist` so the NEXT
    // request resolves through canonicalFor without this ladder.
    if (advanced && (known?.title || (malIdRaw == null && anilistId == null))) {
      const titleQuery = known?.title || String(s).replace(/^(anilist|mal):/i, "").trim();
      if (titleQuery && titleQuery.length >= 2) {
        try {
          const kaze = await getLaneSafe();
          if (kaze) {
            const results = (await kaze.search(titleQuery, 5)) || [];
            if (results.length) {
              // pick the best by similarity (or first if no scorer)
              const { titleSimilarity, titleExactness } = await import("./titles.js");
              const ranked = results
                .map(r => ({ r, s: Math.max(
                  titleSimilarity(r.title, titleQuery),
                  titleSimilarity(r.titleAlt || "", titleQuery),
                ) }))
                .sort((a, b) => (b.s - a.s) ||
                  Number(titleExactness(titleQuery, b.r.title)) - Number(titleExactness(titleQuery, a.r.title)));
              const best = ranked[0]?.r;
              if (best) {
                try { return await canonicalFor(best.title || best.listingId); } catch { /* keep climbing */ }
              }
            }
          }
        } catch { /* kaze offline */ }
      }
    }

    return null;
  }

  // --- slug-shaped keys: resolveSlugIdentity already tried search + the
  //     listing page; a direct slugCanonical retry covers transient
  //     upstream hiccups during the first attempt
  if (looksLikeListingSlug(s)) {
    const slug = cleanListingSlug(s);
    try {
      const c = await slugCanonical(slug, "");
      if (c) return { anilistId: c.anilistId ?? null, malId: c.malId ?? null, slug, canonical: c, via: "flexible-slug" };
    } catch { /* upstream dead */ }
    // v2.6.0 — fall through to title-based search if the slug-lookup
    // failed (e.g. slug has been rotated upstream). The de-slugged
    // string is the most reliable title seed.
    if (advanced) {
      const titleSeed = titleFromSlug(slug);
      if (titleSeed && titleSeed.length >= 2) {
        try {
          const kaze = await getLaneSafe();
          if (kaze) {
            const results = (await kaze.search(titleSeed, 5)) || [];
            for (const r of results) {
              try { return await canonicalFor(r.title || r.listingId); } catch { /* keep climbing */ }
            }
          }
        } catch { /* kaze offline */ }
      }
    }
  }

  // --- plain title: try multi-variant search through the index + kaze
  if (advanced) {
    const variants = new Set([s, s.replace(/[_+]/g, " "), s.replace(/-/g, " ")]);
    for (const v of variants) {
      try {
        const c = await canonicalFor(v);
        if (c) return c;
      } catch (err) {
        const st = err?.status || 500;
        if (st !== 404 && st !== 502) throw err;
      }
    }
  }

  return null;
}

/** v2.6.0 — safe accessor for the kaze lane (dynamic import avoids
 * the ES-module import cycle: keys.js → registry → kaze.adapter →
 * extractors → shape.js → keys.js — the cycle breaks on the await). */
async function getLaneSafe() {
  try {
    const { getLane } = await import("./registry.js");
    return getLane("kaze");
  } catch {
    return null;
  }
}

/**
 * Best title-match for slug-keyed content against the canonical entry.
 * Used internally to map a canonical anime onto a playable listing.
 * Accepts an optional `preferredSlug` — an exact listingId hit wins.
 *
 * v2.5.0 — MULTI-QUERY: upstream search indexes are spelling-sensitive.
 * A romaji query that scores below threshold often resolves perfectly
 * under the English title (and vice versa). Every distinct seed is now
 * tried — romaji, English, slug-derived — and the best-scoring listing
 * across ALL queries wins, instead of "first query that returns
 * anything". Directly cuts the "not found upstream" class of 404s for
 * id-keyed requests whose romaji spelling is decorated ("Sono Bisque
 * Doll wa Koi wo Suru" vs "My Dress-Up Darling").
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

  // v2.5.0: every distinct seed — romaji, English, slug-derived — instead
  // of a single "romaji or bust" query.
  const queries = [...new Set([
    canonical?.titleRomaji || canonical?.title || "",
    canonical?.titleEnglish || "",
    titleFromSlug(preferredSlug || "") || "",
  ].map((q) => String(q).trim()).filter(Boolean))];
  if (!queries.length && canonical?.anilistId) queries.push(String(canonical.anilistId));
  if (!queries.length) return null;

  let best = null;
  let bestScore = 0;
  for (const query of queries) {
    let results = [];
    try {
      results = (await lane.search(query)) || [];
    } catch { /* upstream hiccup — try the next seed */ }
    if (!results.length) continue;
    const scored = pickBestBySimilarity(query, results, (r) => Math.max(
      titleSimilarity(r.title, canonical?.titleRomaji || canonical?.title || ""),
      titleSimilarity(r.title, canonical?.titleEnglish || ""),
      r.titleAlt ? titleSimilarity(r.titleAlt, canonical?.titleRomaji || canonical?.title || "") : 0
    ));
    // keep the best listing across ALL queries; an exact title hit is
    // confident enough to stop early
    if (scored.best && scored.score > bestScore) {
      bestScore = scored.score;
      best = scored.best;
    }
    if (bestScore >= 95) break;
  }
  if (!best || bestScore < config.dedupThreshold) return null;
  return { listingId: cleanListingSlug(best.listingId), title: best.title, matchScore: bestScore };
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

  // v2.4.0: remember every successful resolution — the next endpoint that
  // serves this anime (any surface) inherits the complete identity.
  rememberAnime({ ...canonical, slug: slug || canonical.slug });

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
  // 0. v2.4.0: the shared identity index — anything ANY endpoint already
  //    resolved counts as known (this is what keeps /api/resolve working
  //    for entries other endpoints returned, even mid-AniList-outage)
  const known = lookupAnime({ anilistId, malId, slug, title });
  if (known && (known.title || known.anilistId || known.malId)) {
    return {
      anilistId: anilistId ?? known.anilistId ?? null,
      malId: malId ?? known.malId ?? null,
      slug: slug || known.slug || "",
      title: known.title || title || "",
      titleRomaji: known.titleRomaji || title || "",
      titleEnglish: known.titleEnglish || "",
      titleNative: known.titleNative || "",
      synonyms: known.synonyms || [],
      episodes: known.episodes ?? null,
      format: known.format ?? null,
      status: known.status ?? null,
      year: known.year ?? null,
      poster: known.poster || "",
      banner: known.banner ?? null,
      degraded: true,
    };
  }

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

/** MAL-only canonical entry — enriched through the identity index and a
 *  bounded AniList title anchor so mal-only keys still get anilistId,
 *  synonyms, genres and year when the system knows them (v2.4.0). */
async function malCanonical(malId) {
  try {
    const ishi = getLane("ishi");
    if (!ishi?.malDetails) return null;
    const details = await ishi.malDetails(parseInt(malId, 10));
    if (!details) return null;

    // v2.4.0: fill the AniList side without inventing anything —
    // 1. the shared index (another endpoint may have resolved this MAL id)
    const known = lookupAnime({ malId }) || {};
    // 2. a bounded AniList anchor by the MAL title (cached like every anchor)
    let alEntry = null;
    const anchorTitle = known.title || details.titleEnglish || details.title || "";
    if (!known.anilistId && anchorTitle) {
      const anchored = await anchorTitleToAnilist(anchorTitle);
      if (anchored) alEntry = await anilistById(anchored).catch(() => null);
    } else if (known.anilistId) {
      alEntry = await anilistById(known.anilistId).catch(() => null);
    }

    const merged = {
      anilistId: alEntry?.anilistId ?? known.anilistId ?? null,
      malId,
      slug: known.slug || (alEntry?.slug ?? ""),
      title: details.title || details.titleEnglish || known.title || "",
      titleRomaji: alEntry?.titleRomaji || details.title || "",
      titleEnglish: details.titleEnglish || alEntry?.titleEnglish || "",
      titleNative: details.titleJapanese || alEntry?.titleNative || "",
      synonyms: alEntry?.synonyms ?? known.synonyms ?? [],
      episodes: details.episodes ?? alEntry?.episodes ?? known.episodes ?? null,
      format: details.type || alEntry?.format || known.format || null,
      status: details.status || alEntry?.status || known.status || null,
      year: alEntry?.year ?? known.year ?? (details.aired?.match(/\d{4}/)?.[0] ? parseInt(details.aired.match(/\d{4}/)[0], 10) : null),
      poster: details.image || alEntry?.poster || known.poster || "",
      banner: alEntry?.banner ?? null,
      genres: alEntry?.genres ?? known.genres ?? [],
      degraded: !alEntry,
    };
    rememberAnime(merged);
    return merged;
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
    // v2.4.0: the listing page feeds the shared index (poster/type/etc.)
    rememberAnime({ ...info, slug });
    const anchored = knownTitle || info.title ? await anchorTitleToAnilist(info.title) : null;
    const alEntry = anchored ? await anilistById(anchored) : null;
    const merged = {
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
      genres: alEntry?.genres ?? [],
      degraded: !alEntry,
    };
    rememberAnime(merged);
    return merged;
  } catch {
    return null;
  }
}
