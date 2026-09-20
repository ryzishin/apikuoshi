/**
 * ============================================================
 *  APIKuoshi — src/core/titles.js
 * ============================================================
 *  Cross-name title matching (romaji / English / synonyms / seasons).
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  The same anime appears under many names:
 *    - "Shingeki no Kyojin"        (romaji)
 *    - "Attack on Titan"           (English)
 *    - "Shingeki no Kyojin S4"     (romaji + season marker)
 *  A naive merge would produce duplicates. This module fixes that with a
 *  three-layer strategy:
 *
 *    1. NORMALIZE     — lowercase, strip punctuation/brackets, expand "&",
 *                       drop noise markers (dub/sub/TV/ova/movie...), map
 *                       roman numerals and season words to digits, strip
 *                       season/type markers -> canonical "signature".
 *    2. SIGNATURE     — sorted token set of the normalized title. Two titles
 *                       with identical signatures are the same anime.
 *    3. SIMILARITY    — Dice coefficient over character bigrams + token
 *                       containment for prefix/suffix cases ("Naruto" vs
 *                       "Naruto: Shippuuden" stay distinct, but "Re:Zero kara
 *                       Hajimeru Isekai Seikatsu 2nd Season" vs its English
 *                       "Re:ZERO -Starting Life in Another World- Season 2"
 *                       still merge).
 *
 *  Roman-numeral & number-word handling keeps "JoJo Part 3" / "JoJo III" /
 *  "JoJo Season 3" in the same family while still requiring real overlap.
 * ============================================================
 */

// --- markers that do NOT distinguish one show from another --------------
const NOISE_WORDS = new Set([
  "tv", "the", "a", "an", "dub", "dubbed", "sub", "subbed", "raw",
  "hd", "uncut", "uncensored", "censored", "edition", "complete",
  "series", "episode", "episodes", "eps", "online", "free", "watch",
]);

const TYPE_WORDS = new Set([
  "ova", "ova's", "ovas", "ona", "special", "specials", "movie", "film",
  "recap", "picture", "drama", "pv", "cm", "opening", "ending",
]);

const SEASON_WORDS = new Set([
  "season", "saison", "part", "cour", "saga", "chapter", "arc",
  "shou", "hen", "seasons",
]);

// ordinal words -> digits ("second season" == "season 2")
const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

const ROMAN = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9,
  x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15,
};

const JP_SEASON = {
  // common Japanese ordinal season markers (romaji)
  ichi: 1, ni: 2, san: 3, shi: 4, go: 5, roku: 6,
  shichi: 7, nana: 7, hachi: 8, kyuu: 9, ky: 9, juu: 10,
};

/** Full normalization: lowercase, punctuation-free, noise removed. */
export function normalizeTitle(input) {
  if (!input || typeof input !== "string") return "";
  let s = input.normalize("NFKC").toLowerCase();

  // unify common separators before stripping punctuation
  s = s.replace(/&/g, " and ");
  s = s.replace(/\u2019|\u2018|'/g, "");       // possessives: demon's -> demons
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");       // all punctuation -> space

  // strip a leading "the "
  s = s.replace(/^the\s+/, "");

  return s.split(/\s+/).filter(Boolean);
}

/**
 * Extract season number if the title carries one (digits, ordinals,
 * romans, Japanese ordinals). Returns { season, rest } where `rest`
 * is the token list minus the season marker chunk.
 */
function splitSeason(tokens) {
  let season = null;
  const rest = [];
  const n = tokens.length;

  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    const prev = rest[rest.length - 1];

    // "season 2" / "part 3" / "cour 1"
    if (SEASON_WORDS.has(t) && i + 1 < n) {
      const nxt = tokens[i + 1];
      const asNum = numberLike(nxt);
      if (asNum !== null) { season = asNum; i++; continue; }
    }
    // "2nd season" / "3rd part"
    if (numberLike(t) !== null && i + 1 < n && SEASON_WORDS.has(tokens[i + 1])) {
      season = numberLike(t);
      i++;
      continue;
    }
    // trailing roman numeral as season (JoJo style): "... stardust crusaders iii"
    if (ROMAN[t] !== undefined && i === n - 1 && rest.length > 0) {
      season = ROMAN[t];
      continue;
    }
    // Japanese ordinal directly attached to previous word handled above;
    // bare JP ordinal in the middle is risky -> keep as normal token.
    rest.push(t);
  }
  return { season, rest };
}

/** "2nd"/"1st"/"3rd" -> 2/1/3 ; "2" -> 2 ; ordinals/romans/jp -> number ; else null */
function numberLike(token) {
  const m = token.match(/^(\d+)(st|nd|rd|th)?$/);
  if (m) return parseInt(m[1], 10);
  if (ORDINALS[token] !== undefined) return ORDINALS[token];
  if (ROMAN[token] !== undefined) return ROMAN[token];
  if (JP_SEASON[token] !== undefined) return JP_SEASON[token];
  return null;
}

/**
 * Canonical signature — the dedup key.
 * Returns null-ish-safe string. Two titles with equal signatures are
 * considered the SAME anime regardless of romaji vs English.
 *
 * v2.2.1 FIX — bare digits are IDENTITY, not noise:
 *   "Steins;Gate 0" must never share a signature with "Steins;Gate".
 *   Previously EVERY pure-number token was dropped, so both collapsed to
 *   "gate steins" and every similarity score between the two shows was
 *   100 — the catalog then merged them (search) and the listing matcher
 *   picked whichever result upstream happened to rank first (episodes /
 *   servers / streams of the ORIGINAL came back as Steins;Gate 0's).
 *   Only YEAR-like numbers are noise now ("one piece 2023" still merges
 *   with "one piece"); entry numbers ("0", "2", "02") are kept and
 *   canonicalized so "02" == "2".
 */
export function titleSignature(input) {
  const tokens = normalizeTitle(input);
  if (!tokens.length) return "";

  // strip season/type markers for the base signature but remember them
  const { rest } = splitSeason(tokens);
  const filtered = rest.filter((t) => !NOISE_WORDS.has(t) && !TYPE_WORDS.has(t));

  // canonicalize numeric tokens ("02" -> "2") and drop YEAR-like numbers
  // (1900-2099) — release years are noise, entry/sequel numbers are not
  const canon = filtered.map((t) => (/^\d+$/.test(t) ? String(parseInt(t, 10)) : t));
  const meaningful = canon.filter((t) => !yearLike(t));

  const finalTokens = (meaningful.length ? meaningful : canon).sort();
  return finalTokens.join(" ");
}

/** "2023" (a release year) -> true; "0"/"2" (entry numbers) -> false. */
function yearLike(token) {
  return /^(18|19|20)\d{2}$/.test(token);
}

/** Kept season/type info, used for stricter re-checks. */
export function titleMeta(input) {
  const tokens = normalizeTitle(input);
  const { season, rest } = splitSeason(tokens);
  const types = rest.filter((t) => TYPE_WORDS.has(t));
  return { season, types };
}

/** Dice coefficient over character bigrams of the joined signature. */
function bigramDice(a, b) {
  if (a === b) return 100;
  if (a.length < 2 || b.length < 2) return a === b ? 100 : 0;

  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g);
    if (c > 0) { hits++; grams.set(g, c - 1); }
  }
  return (2 * hits / (a.length - 1 + b.length - 1)) * 100;
}

/**
 * EXACT-title check (normalization-aware) — the TIE-BREAKER.
 * Signature equality is NOT enough: "Steins;Gate" and "Steins;Gate 0"
 * used to share a signature. This compares the FULL normalized token
 * list (digits included), so only genuinely identical spellings tie here.
 */
export function titleExactness(a, b) {
  const ta = normalizeTitle(a).join(" ");
  const tb = normalizeTitle(b).join(" ");
  return Boolean(ta && tb && ta === tb);
}

/**
 * Pick the best candidate by title similarity with a deterministic
 * EXACT-title tie-break.
 *
 * WHY THIS EXISTS — the Steins;Gate 0 incident (v2.2.0):
 *   kaze search returns "Steins;Gate 0" BEFORE "Steins;Gate" for both
 *   queries. Every scorer that compares scores with strict `>` keeps the
 *   FIRST candidate on a tie — so anilist:9253 (the original) was mapped
 *   onto Steins;Gate 0's listing whenever the two tied. Scores alone can
 *   no longer decide; an exact normalized-title hit always wins a tie,
 *   regardless of upstream order.
 *
 * `scorer(candidate)` must return the best similarity for that candidate.
 * Returns { best, score, exact } — best may be null for an empty list.
 */
export function pickBestBySimilarity(query, candidates, scorer) {
  let best = null;
  let bestScore = -1;
  let bestExact = false;
  for (const c of candidates || []) {
    const score = scorer(c);
    // v2.5.1: titleNative joins the exactness check — a native/CJK query
    // ("葬送のフリーレン") ties exactly against the candidate's native
    // title even when its public `title` is English, so the real series
    // beats a same-franchise spin-off on the tie-break.
    const exact = titleExactness(query, c?.title || "") ||
      (c?.titleAlt ? titleExactness(query, c.titleAlt) : false) ||
      (c?.titleNative ? titleExactness(query, c.titleNative) : false);
    if (score > bestScore || (score === bestScore && exact && !bestExact)) {
      best = c;
      bestScore = score;
      bestExact = exact;
    }
  }
  return { best, score: bestScore, exact: bestExact };
}

/**
 * Similarity score 0..100 between two titles, considering BOTH raw
 * signatures (romaji vs english safe) and token containment
 * ("naruto" vs "naruto shippuuden" -> moderate, NOT merged by default;
 *  "overlord" vs "overlord iv" -> season difference, merged only if
 *  one side has no explicit conflicting season).
 */
export function titleSimilarity(titleA, titleB) {
  const sigA = titleSignature(titleA);
  const sigB = titleSignature(titleB);
  if (!sigA || !sigB) return 0;

  const metaA = titleMeta(titleA);
  const metaB = titleMeta(titleB);

  // season/type guards — applied to EVERY path (even exact signature hits),
  // so "One Piece Movie 1" can never equal the "One Piece" series just
  // because the marker words are stripped from the signature.
  const seasonClash =
    metaA.season !== null && metaB.season !== null &&
    metaA.season !== metaB.season;
  const typeA = new Set(metaA.types);
  const typeB = new Set(metaB.types);
  const typeClash =
    (typeA.has("movie") !== typeB.has("movie")) ||
    (typeA.has("ova") !== typeB.has("ova")) ||
    (typeA.has("special") !== typeB.has("special")) ||
    (typeA.has("ona") !== typeB.has("ona"));

  if (sigA === sigB) {
    if (seasonClash) return 40;               // "Part 2" vs "Part 3" — different shows
    if (typeClash) return 60;                 // spin-off marker on one side only
    // XOR: exactly ONE side carries an explicit season ("Overlord II" vs
    // "Overlord") — related but distinct entries. Both sides with the SAME
    // season ("2nd Season" vs "Season 2") fall through to 100.
    const oneSidedSeason =
      (metaA.season !== null) !== (metaB.season !== null);
    if (oneSidedSeason) return 70;
    return 100;
  }

  const tokensA = new Set(sigA.split(" "));
  const tokensB = new Set(sigB.split(" "));
  if (!tokensA.size || !tokensB.size) return 0;

  // token-set overlap (Jaccard)
  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared++;
  const jaccard = shared / (tokensA.size + tokensB.size - shared);

  // containment bonus: short query fully inside long title (and vice versa)
  const contained =
    (tokensA.size <= tokensB.size && [...tokensA].every((t) => tokensB.has(t))) ||
    (tokensB.size <= tokensA.size && [...tokensB].every((t) => tokensA.has(t)));

  let score = Math.max(bigramDice(sigA, sigB) * 0.6, jaccard * 100 * 0.9);
  if (contained) score = Math.max(score, 62);

  if (seasonClash) score = Math.min(score, 40);
  if (typeClash) score = Math.min(score, 45);

  return Math.round(score);
}

/** Convenience: best match from a candidate list. */
export function bestMatch(query, candidates, threshold = 78) {
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = Math.max(
      titleSimilarity(query, c.title || ""),
      c.titleAlt ? titleSimilarity(query, c.titleAlt) : 0
    );
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= threshold ? { ...best, score: bestScore } : null;
}

/**
 * Group a list of entries (from many sources) into unique anime.
 * Entries: [{ key, title, titleAlt, source, ... }]
 * Returns [{ canonical, members }]
 */
export function groupEntries(entries, threshold = 78) {
  const groups = [];

  for (const entry of entries) {
    let target = null;

    // 1. exact signature hit
    const sig = titleSignature(entry.title);
    if (sig) {
      target = groups.find((g) => g.signatures.has(sig));
    }

    // 2. alt-title signature hit (romaji vs english direct hit)
    if (!target && entry.titleAlt) {
      const altSig = titleSignature(entry.titleAlt);
      if (altSig) target = groups.find((g) => g.signatures.has(altSig));
    }

    // 3. fuzzy similarity against every group representative
    if (!target) {
      for (const g of groups) {
        const score = Math.max(
          titleSimilarity(entry.title, g.title),
          entry.titleAlt ? titleSimilarity(entry.titleAlt, g.title) : 0,
          g.altTitle ? titleSimilarity(entry.title, g.altTitle) : 0
        );
        if (score >= threshold) { target = g; break; }
      }
    }

    if (!target) {
      target = {
        title: entry.title || entry.titleAlt || "",
        altTitle: entry.titleAlt || null,
        signatures: new Set(),
        members: [],
      };
      groups.push(target);
    }

    if (sig) target.signatures.add(sig);
    if (entry.titleAlt) {
      const altSig = titleSignature(entry.titleAlt);
      if (altSig) target.signatures.add(altSig);
    }
    // keep the richest metadata as representative
    if ((entry.title || "").length > target.title.length) {
      const oldAlt = target.altTitle;
      target.title = entry.title;
      if (!target.altTitle || target.altTitle === oldAlt) target.altTitle = entry.titleAlt || target.altTitle;
    }
    if (!target.altTitle && entry.titleAlt && entry.titleAlt !== target.title) {
      target.altTitle = entry.titleAlt;
    }
    target.members.push(entry);
  }

  return groups.map((g) => ({
    title: g.title,
    altTitle: g.altTitle,
    members: g.members,
  }));
}
