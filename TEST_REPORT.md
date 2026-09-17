# APIKuoshi v2.3.0 — Browse/Catalog + Art-Enrichment Test Report

> **Release scope:** extend the canonical anime shape to every browse/catalog
> endpoint + integrate the Kitsu & TMDB art providers into one enrichment
> chain. Before-state = live **v2.2.1** at `https://apikuoshi-v2.onrender.com`;
> after-state = local **v2.3.0** build, same upstream sources, same day.

## 1. Per-endpoint completeness census (before → after)

Completeness = % of entries where the field is non-empty/non-null.
"cov" = the response's `enrichment.coverage` (which provider supplied the
winning poster). After-state covers are Kitsu-filled without replacing
upstream posters (upstream poster wins → `artSource: "upstream"`).

| Endpoint (page 1) | items | title | poster | cover | artSource | episodes | type | cov (after) |
|---|---|---|---|---|---|---|---|---|
| `/api/home` | 30 (v2.2.1: 30) | 0% → **100%** | 100% → 100% | — → **47%** | — → **100%** | 0% → 40% | 0% → 40% | upstream 30 |
| `/api/spotlight` | 9 | 100% | 100% | — → **56%** | — → **100%** | 0% | 0% | upstream 9 |
| `/api/trending` | 12 | 100% | 100% | — → **33%** | — → **100%** | 100% | 0% → **100%** | upstream 12 |
| `/api/trending-sidebar` | 39 | **0% → 100%** | 100% | — → **49%** | — → **100%** | 0% → 31% | 0% → 31% | upstream 39 |
| `/api/top-ten` | 27 | **0% → 100%** | 100% | — → **56%** | — → **100%** | 0% | 0% | upstream 27 |
| `/api/top-rankings?sort=week` | 10 | 100% | 100% | — → **50%** | — → **100%** | 0% | 100% | upstream 10 |
| `/api/popular` | 30 | 100% | 100% | — → **63%** | — → **100%** | 100% | 0% | upstream 30 |
| `/api/upcoming` | 12 | 100% | 100% | — → **42%** | — → **100%** | 0% | **0% → 100%** | upstream 12 |
| `/api/completed?page=1` | 5 | 100% | 100% | — → **20%** | — → **100%** | 100% | 100% | upstream 5 |
| `/api/new-release?page=1` | 40 | 100% | 100% | — → **33%** | — → **100%** | 100% | 25% | upstream 40 |
| `/api/newly-added?page=1` | 40 | 100% | 100% | — → **25%** | — → **100%** | 100% | 25% | upstream 40 |
| `/api/latest-updated?page=1` | 40 | 100% | 100% | — → **25%** | — → **100%** | 100% | 25% | upstream 40 |
| `/api/recently-updated?tab=all` | 12 | 100% | 100% | — → **33%** | — → **100%** | 100% | 100% | upstream 12 |
| `/api/schedule` | 12 | 100% | **0% → 92%** | — → **8%** | — → **92%** | 0% | 0% | **kitsu 11** |
| `/api/airing` | 12 | 100% | **0% → 92%** | — → **8%** | — → **92%** | 0% | 0% | **kitsu 11** |
| `/api/az-list/a?page=1` | 40 | 100% | 100% | — → **55%** | — → **100%** | 100% | 25% | upstream 40 |
| `/api/filter?genre=action` | 30 | 100% | 100% | — → **30%** | — → **100%** | 100% | 100% | upstream 30 |
| `/api/genre/action?page=1` | 30 | 100% | 100% | — → **67%** | — → **100%** | 100% | 0% | upstream 30 |
| `/api/type/tv?page=1` | 30 | 100% | 100% | — → **30%** | — → **100%** | 100% | 0% | upstream 30 |
| `/api/status/airing?page=1` | 40 | 100% | 100% | — → **28%** | — → **100%** | 100% | 25% | upstream 40 |
| `/api/search?q=…` | n | 100% | 100% | — → kitsu-filled | — → **100%** | 100% | 100% | upstream |
| `/api/meta/season` | 30 | 100% | 100% | — → **27%** | — → **100%** | 100% | 100% | upstream 30 |
| `/api/meta/recommendations` | 12 | 100% | 100% | — | — → **100%** | 100% | — | upstream 12 |
| `/api/seasons/:slug` | 22 | 100% | 100% | kitsu | — → **100%** | — | — | upstream |
| `/api/watch-order/:slug` | 10 | 100% | 100% | kitsu | — → **100%** | — | — | upstream |

Note on `year`/`status` on kaze browse rows: upstream catalog cards do not
render year/status (verified against the live pages), so those stay `null`
by the "never invent" rule; the same fields are populated on every
AniList-anchored surface (search, meta, season, detail).

## 2. Bug-fix verification (targeted probes, after-state)

| # | Bug (live v2.2.1) | After (v2.3.0) |
|---|---|---|
| 1 | `/api/top-ten` items: `title: ""` on 100% of rows (upstream `name` field ignored); `rank` dropped | **27/27 titles, 27/27 ranks** ("Mushoku Tensei: Jobless Reincarnation Season 3", rank 1) |
| 2 | `/api/trending-sidebar` same `name`-vs-`title` bug | **39/39 titles** |
| 3 | `/api/schedule` + `/api/airing`: poster 0%, airing time/episode dropped | **11/12 posters via Kitsu** (`artSource: "kitsu"`), 12/12 `airingTime`, `airingEpisode` present |
| 4 | `titleNative` = romaji on 100% of browse rows (pollution) | **0/12** rows with `titleNative === titleRomaji` |
| 5 | `/api/random` returned the raw extractor object | Full canonical shape: `key/slug/title/…/artSource` + detail art; `?genre=x` → `ignoredParams: ["genre"]` |
| 6 | `/api/type/notarealtype` → 502 | **200, count 0** (same for `/api/status/…`) |
| 7 | `/api/recently-updated?tab=bogus` silently served "all" | **400** with valid values listed |
| 8 | `/api/top-rankings?sort=bogus` silently served default | **200 + `invalidParams:["bogus (valid sorts: top, week, month)"]`** |
| 9 | `az-list/%C3%A9` | **400** with clear message (unchanged, verified) |
| 10 | `az-list/0` (digit page) | **200** (unchanged, verified) |
| 11 | upcoming rows: `type` 0% (layout drift) | **100%** (`.meta .right` selector fix); `releaseDate` honestly empty — upstream renders none (verified against live HTML) |
| 12 | spotlight `description`/`date`/`quality` dropped | `date`→`releaseDate` + `quality` now carried; `description` honestly `""` (upstream `.desc` empty — verified) |

## 3. Cross-endpoint consistency (after-state)

Seed: first `/api/trending` entry ("Tomb Raider King") → same title via
`/api/search`, `/api/anime?key=<slug>`, `/api/meta?key=<slug>`.

| Check | v2.2.1 | v2.3.0 |
|---|---|---|
| `/api/anime` vs `/api/meta` canonical fields (key, slug, title*, poster, type, status, year, episodes, score, season, cover, artSource, synopsis, genres) | diverged (meta had score/season/synopsis, anime did not; different depth) | **NONE — field-for-field identical** |
| poster URL: trending vs search vs detail (same title) | search showed AniList art, browse/detail showed listing art | **agreed** (search now prefers the primary lane's listing art; AniList art is the fallback) |
| status vocabulary: search (`RELEASING`) vs browse (`""`/kaze strings) | mixed vocabularies | **one vocabulary** — `Currently Airing` / `Finished Airing` / `Not Yet Aired` / `Cancelled` / `On Hiatus` everywhere |
| type vocabulary: AniList `MOVIE` vs kaze `Movie` | mixed | **one vocabulary** — `TV, TV Short, Movie, OVA, ONA, Special, Music` |
| shape drift browse-vs-detail | browse rows missing cover/artSource/season/score/description; art `""` vs missing | **same key set everywhere**; art fields explicit (`null` when nothing could fill them) |

## 4. Enrichment coverage (after-state)

- `/api/schedule` + `/api/airing` (poster-less upstream rows): **11/12 filled
  via Kitsu** (1 title with no Kitsu match → explicit `null`, `artSource: null`).
- Browse rows with upstream posters: poster stays upstream (`artSource:
  "upstream"`), **Kitsu fills `cover`** on 8–67% of rows per endpoint
  (title-match success rate against kitsu.app).
- `/api/anime/episodes?key=` (Tomb Raider King): 11/11 thumbnails, all via
  series-poster fallback (`thumbSource: "poster"`) — no upstream thumbs and
  no Kitsu/TMDB match for this title; coverage block reports per-source
  counts so clients can audit.
- `/api/chain`: `episode-art` step reports the thumbnail source; streams,
  servers, probe verdict untouched (4 streams resolved, best present,
  verdict `unverified` under `probe=0`).
- **TMDB_API_KEY unset** (default run): `enrichment.tmdb: false` in every
  response, zero log noise, zero latency — Kitsu-only path verified clean.
- **TMDB_API_KEY set (bogus, fault-injected)**: every TMDB call 401s →
  chain degrades to "no data"; `/api/schedule` still 200 with 11/12 Kitsu
  posters; **zero unhandled errors in the server log**.
- **Total provider failure (dead proxy for all provider traffic)**: detail
  art → explicit nulls; list coverage `{upstream:0, kitsu:0, tmdb:0, none:6,
  total:6}`; upstream posters preserved; **0 exceptions escaped**.

## 5. Test suites

| Suite | Result |
|---|---|
| `npm run check` (repo self-verification) | **30/30 passed** |
| Steins;Gate identity regression (`scripts/test_steinsgate.mjs`) | **13/13 passed** (v2.2.1 fix intact: resolveIdentity("Steins;Gate")→9253, ("Steins;Gate 0")→21127) |
| v2.3.0 resilience suite (`extractSeasonHint` unit cases, `mapPool` bounded concurrency, provider-failure fault injection) | **16/16 passed** |
| Negative paths (`az-list/é` 400, `recently-updated?tab=bogus` 400, `meta/season` validation, `filter` ignoredParams, invalid type/status 200-count-0) | all pass |
| Playback pipeline | untouched (no diffs in streamInfo/streamResolver/cdn.helper/proxies/download; chain gained only the read-only `episode-art` step) |

## 6. Additional findings (audit, not fixed by design)

- `/api/completed` returns the homepage "completed" section (~5 items): the
  upstream site has **no standalone /completed page** (404s), so pagination
  on this lane is a no-op. Documented instead of fabricating a deeper list.
- Upstream renders no release dates in the upcoming section and no
  descriptions in spotlight `.desc` — those fields stay honestly empty.
- Browse rows cannot carry `year`/`status` without an AniList/MAL identity
  lookup per row (kaze cards do not render them, and the two attached
  providers do not expose metadata fields). Inventing them was not allowed;
  they are populated on every identity-anchored surface.
- `kitsu.app` title-search misses a minority of titles (e.g. "Tomb Raider
  King") — those degrade to explicit nulls rather than wrong art.

---

# APIKuoshi v2.2.0 — Catalog & Metadata Test Report

> **v2.2.1 ADDENDUM (2026-09-17) — the Steins;Gate 0 incident.** A regression
> shipped in v2.2.0 is fixed in v2.2.1. Full before/after below.
>
> | Probe | v2.2.0 (live, before) | v2.2.1 (local, after) |
> |---|---|---|
> | `titleSimilarity("Steins;Gate","Steins;Gate 0")` | **100** (same anime) | **62** (distinct) |
> | `titleSignature` of the two shows | `"gate steins"` = `"gate steins"` | `"gate steins"` vs `"0 gate steins"` |
> | `/api/search?q=steins gate` | both shows merged into ONE entry (longer title = S;G0 won) | two separate TV entries — S;G (2011) + S;G0 (2018) |
> | `/api/anime/episodes?key=anilist:9253` (original) | **23 eps, ids 29078–29100** ← S;G0's listing; original's 24-ep listing unreachable | **24 eps, ids 1163–1186** — its own listing (`steins-gate-c93ww`) |
> | `/api/anime/episodes?key=anilist:21127` (S;G0) | 23 eps, ids 29078–29100 | 23 eps, ids 29078–29100 (unchanged, correct) |
> | `/api/watch?key=anilist:9253&ep=1` vs `?key=anilist:21127&ep=1` | identical streams for both keys | **0 overlapping stream URLs** |
> | `/api/chain?key=anilist:9253&ep=1&probe=0` | S;G0 episode | ep 1 "Turning Point" (the original) |
> | `resolveIdentity("Steins;Gate" / "Steins;Gate 0")` | could tie-break wrongly via upstream order | 9253 / 21127 deterministically |
> | Regression suite `scripts/test_steinsgate.mjs` | — | **13/13 PASS** |
>
> Captures: `probe/steinsgate/` (live before: `r1_sg.json`, `r2_sg0.json`,
> `e1_sg.json`, `e2_sg0.json`; local after: `after_*.json`).
> **Root cause:** `titleSignature()` dropped all bare digits, making the two
> titles signature-identical; `matchSlug` and friends broke 100-vs-100 ties by
> upstream order (kaze lists "Steins;Gate 0" first for both spellings).
> **Fix:** digits are identity (only years 1900–2099 are noise; `"02"`→`"2"`),
> plus an exact-title tie-break (`pickBestBySimilarity`) at all six identity
> decision points; episodes cache key bumped `v3`→`v4`. Playback pipeline
> untouched.

**Scope:** catalog + search + detail data only. Playback pipeline untouched
(`/api/watch` internals, `/api/proxy/*`, `/api/download`, `/videojs/`, AES,
token refresh — verified working, no changes).

**Method:** every probe was executed twice —

- **BEFORE** against the live deployment `https://apikuoshi-etau.onrender.com`
  (v2.1.0, 2026-09-17) — 56 endpoint captures in `probe/before/`
- **AFTER** against v2.2.0 running locally (`node server.js`) — 56 endpoint
  captures in `probe/final/`

Every "after" probe below is a real request with a real response capture.

---

## 1. Primary bug verification (before → after)

| # | Bug (reported) | Before (live v2.1.0) | After (v2.2.0) |
|---|----------------|----------------------|----------------|
| 1 | Anime-shaped inconsistency / null divergence | `/api/anime`, `/api/anime/episodes`, `/api/anime/servers`, `/api/chain` each had a different object shape; `key: null` when AniList down; `format` vs `type` vs `totalEpisodes` naming drift | All four emit the same core identity block built by `src/core/shape.js` (`key, slug, anilistId, malId, title, titleRomaji, titleEnglish, titleNative, synonyms, poster, type, year, episodes, status, genres`); uniform null policy (strings `""`, arrays `[]`, ids `null`) |
| 2 | Meta endpoints disagree on identity | `/api/meta` (AniList shape, no slug), `/api/meta/mal` (invented key from raw input), `/api/meta/trending` (raw kaze rows `slug\|poster\|title\|japaneseTitle\|sub\|dub\|total\|type`), `/api/meta/season` (no key/slug) | All 7 meta endpoints emit the unified identity; captured `animeKeys=`/`results0keys=` identical across `meta`, `meta_mal_key`, `meta_title_key`, `meta_season`, `meta_trending` |
| 3 | `/api/meta/recommendations` assumes AniList | AniList-only; items had no `key`, no `titleEnglish`, no `slug`; `key=mal:52991` → **502**; MAL recommendations never surfaced | Merged AniList + MAL (`sources: {anilist, mal}`), deduped by MAL id with votes merged; every item carries `key/slug/…/source/votes`; MAL-only entries keep `mal:<id>` keys; `key=mal:52991`, title keys → **200** |
| 4 | AniList-only canonical keys; slug lost | slug keys 404 (`?key=frieren-odmau` → 404); search results had **no** slug; colon titles → **400** "Unknown key format" | All key formats resolve: `anilist:` / `mal:` / numeric / **slug** / title-with-colons / native-title. Search/suggestions/catalog items all carry `slug`. `/ep-N` suffixes stripped |
| 5 | Seasons/specials grouping | `/api/seasons/:slug` + `/api/watch-order/:slug` accepted ONLY raw kaze slugs (anilist keys → 502); entries were raw upstream rows; object payloads double-nested `data.data`; upstream numeric ids could collide with the numeric-AniList-id key format | Any key format works (`/api/watch-order/anilist:21` → 10 related, grouped `groups.trending=10`); entries unified + `relation` + `animeId` preserved; single `data` nesting; relations graph (`prequel/sequel/specials/ova/ona/movie/sideStory/alternative/summary`) added to `/api/anime` + `/api/meta` |
| 6 | Episode thumbnails | No `thumbnail`/`poster` on any episode (fields missing entirely) | `thumbnail` on every episode, series-poster fallback applied consistently — captured **28/28 episodes populated** (Sousou no Frieren); same field in `/api/chain` `episode` block and `/api/watch` |

## 2. Endpoint-by-endpoint results (v2.2.0)

### Search & resolve
| Endpoint | Result | Evidence |
|---|---|---|
| `/api/search?q=` (romaji / english / partial / synonym / non-latin / misspelled) | **200** ×6, count 34/32/3/30/16/0 | unified items: `key\|slug\|title\|titleRomaji\|titleEnglish\|titleNative\|poster\|type\|status\|synonyms\|genres\|anilistId\|malId\|year\|episodes\|sub\|dub`; dedup keeps merged entries, `slug` present (was missing in v2.1) |
| `/api/suggestions?keyword=naruto` | **200** | richer extractor (adds japaneseTitle/sub/dub), unified shape + `count` |
| `/api/resolve?title=anilist:154587` / `mal:52991` / `154587` / `Sousou no Frieren` / `Frieren: Beyond Journey's End` / `葬送のフリーレン` | **200** ×6 (was 502/502/502/404/**400**/404) | every identity returns `key + playable + anime{unified}` |

### Anime
| Endpoint | Result | Evidence |
|---|---|---|
| `/api/anime?key=` (anilist / mal / numeric / title / english / **slug** / slug+`/ep-3`) | **200** ×7 (slug formats were 404/502 in v2.1) | `relations` block with grouped buckets + endpoint map; `anime.slug` always populated |
| `/api/anime/episodes?key=` (anilist / mal / title) | **200** ×3 | `number\|title\|titleJapanese\|thumbnail\|aired\|filler\|recap\|id`; MAL real titles merged; `thumbnail` 28/28 populated |
| `/api/anime/servers?key=…&ep=1[&type=sub]` | **200** ×2 | server list unchanged (playback untouched), response carries canonical `key` + `poster` |

### Meta
| Endpoint | Result | Evidence |
|---|---|---|
| `/api/meta?key=` (anilist / mal / title) | **200** ×3 | unified `anime` + `relations` + `availability` |
| `/api/meta/characters?key=` | **200** | `role\|character\|voiceActor` (unchanged shape), canonical key |
| `/api/meta/recommendations?key=` (anilist / mal / title) | **200** ×3 | dual-source; `sources: {anilist: 12, mal: 12}` merged → 12 deduped unified items with `rating`/`votes`/`source` |
| `/api/meta/season?season=WINTER&year=2024` | **200** | unified items + AniList `pagination` passthrough; invalid season/year → clear **400** |
| `/api/meta/mal?key=` (mal / anilist / title) | **200** ×3 | `key` is now always the canonical `mal:<id>` resource key; adds unified `anime` block |
| `/api/meta/external?key=` (anilist / mal) | **200** ×2 | `externalLinks`/`streamingPlatforms` are `[]` on failure (were `null`); adds canonical `key` |
| `/api/meta/trending` | **200** | was raw kaze rows → now unified list items |

### Catalog
| Endpoint | Result | Evidence |
|---|---|---|
| `/api/az-list/a` | **200** | unified items + `pagination {page, totalPages:19, hasNextPage:true}` (totalPages was dropped before); invalid letter → **400** |
| `/api/filter?genre=action&type=TV&status=ongoing` | **200** | unified items; unknown params reported in `ignoredParams[]` |
| `/api/genre/action`, `/api/genre/action,comedy` | **200** ×2 | unified items (multi-genre path included) |
| `/api/type/tv`, `/api/status/ongoing` | **200** ×2 | unified items |
| `/api/seasons/frieren-beyond-journey-s-end-c6fbj` | **200** | `totalSeasons` + unified entries with `relation` buckets + `animeId` preserved |
| `/api/seasons/anilist:154587` | **200** (was **502**) | key-resolved → listing slug → sidebar data; candidate-slug retry survives stale listings |
| `/api/watch-order/…` (slug / anilist:21 / title) | **200** ×3 | `related` + `groups` (bucketed) + unified entries |

### Chain (read-only sanity — streams untouched)
| Endpoint | Result | Evidence |
|---|---|---|
| `/api/chain?key=anilist:154587&ep=1&probe=0` | **200** | `anime` block unified (incl. `slug`, `totalEpisodes` kept for compatibility); `episode` block carries `thumbnail` + real MAL title |
| `/api/chain?slug=frieren-beyond-journey-s-end-c6fbj&ep=1&probe=0` | **200** (was **404** on the probed slug) | same unified anime block; steps/timing/usage unchanged |

## 3. Additional bugs found & fixed during the audit

| Found | Root cause | Fix |
|---|---|---|
| One transient AniList outage → **24 h** of 502/empty search & resolve | `withCache` cached the failure result (`null`/`[]`) for the full 24 h TTL | `withCacheOk`: good results keep long TTL, failures/empties cached ≤45 s |
| Colon-containing titles rejected | `resolveKeyToAnilist` treated any `x:y` string as an unknown key format | only `anilist:`/`mal:` prefixes are key formats; everything else is a title |
| Wrong-anime anchoring under upstream ranking quirks | `perPage=1` trusted SEARCH_MATCH order → a mini-anime hijacked `frieren-…-c6fbj` | rank 5 AniList candidates by title similarity (romaji/english/native/synonyms) with a confidence threshold |
| Slug `/ep-N` suffixes leaked from filter/category pages | `parseListItem` splits watch hrefs; `/watch/x/ep-1` → `x/ep-1` | `cleanListingSlug()` at adapter + route boundary (download path already did this) |
| Upstream numeric ids in `slug` collide with numeric-AniList-id keys | sidebar items carry internal ids (`"7457"`) in the slug position | numeric-only slugs → deterministic title slug; raw id preserved as `animeId` |
| `data.data` double nesting on object payloads | `sendList` unwrapped only array `.data` | unwrap lane wrapper once + normalize inner item arrays |
| Pagination metadata dropped | kaze passthrough kept only `data` | passthrough preserves `totalPages`/`letter`; routes emit `pagination` |
| Silently ignored query params | `/api/filter` forwarded 15 known params, ignored the rest | `ignoredParams[]` reported in the response |
| `az-list/zz` → opaque 502; `meta/season?season=foo` → silent empty | no input validation | clear 400s with allowed values |
| MAL-only 404 semantics | nonexistent `mal:<id>` answered 502 "Could not load metadata" | 404 `Anime not found (mal:<id>)` |
| `/api/suggestions` used the poorer of two extractors | `extractSearchSuggestions` (4 fields) vs `extractSuggestions` (7 fields) | switched to the richer extractor + unified shape |
| episodes/servers/watch could not fall back to MAL-only identities | `ishi.episodes/servers/watch` were always called with `malId=null` | resolved `malId` threaded through (enables `getSiteIdsByMal` path) |
| seasons/watch-order 200-but-empty under upstream bursts | upstream throttles with empty shell pages; mirror only switches on hard failures | bounded empty-retry after mirror reset + 30 min non-empty sidebar cache + candidate slug loop |

## 4. Known limitations (honest, not fixed)

- Upstream (anikoto mirror network) rate-limits request **bursts** with
  200-but-empty pages. The API now degrades gracefully (retries once with a
  fresh mirror cycle, then serves the last good cached sidebar) — but a cold,
  bursty client can still see fewer sidebar items than the site shows in a
  browser. Spread requests or rely on the 180 s response caches.
- Catalog list items (az-list/filter/genre/type/status) carry no AniList/MAL
  ids because the upstream pages don't provide them — `key` there is the
  listing slug, by design (no data invented). Feeding those slugs to any
  identity endpoint resolves them fully.
- `/api/search` does not emit a `pagination` block: results are merged across
  lanes + AniList, so a single "totalPages" would be fabricated.

## 5. Regression checks

- Response envelope `{ success, api, kind?, count, results[] }` preserved on
  every list endpoint (captured in every probe).
- `probe=0`, `type=`, `channel=` chain options and `steps`/`timing`/`usage`
  blocks unchanged.
- Stream fields (`provider`, `originalName`, `qualities`, `subtitles`,
  `skipIntro`, `probe`, `proxiedUrl`) unchanged in `/api/watch` and
  `/api/chain` — playback pipeline diffs: **none** (`git diff` limited to
  identity/shape/route/adapter layering; `streamInfo`, `streamResolver`,
  `cdn.helper`, proxies, download untouched).
