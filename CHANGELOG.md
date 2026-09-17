# Changelog

All notable changes to APIKuoshi are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

---

## [2.3.0] — 2026-09-17 · browse/catalog canonical shape + Kitsu & TMDB art-enrichment chain

**Goal:** a `200 OK` is not success if the payload is missing fields the same anime
carries on `/api/anime?key=` or `/api/search`. This release extends the v2.2
consistency contract to **every browse/catalog endpoint** and plugs the two new
art providers (`src/core/kitsu.js`, `src/core/tmdb.js`) into a single enrichment
chain with strict fallbacks. Streams untouched.

### The canonical shape, everywhere (browse + catalog)
Every listing endpoint — `/api/home`, `/api/spotlight`, `/api/trending`,
`/api/trending-sidebar`, `/api/top-ten`, `/api/top-rankings`, `/api/popular`,
`/api/random`, `/api/upcoming`, `/api/completed`, `/api/new-release`,
`/api/newly-added`, `/api/latest-updated`, `/api/recently-updated`,
`/api/schedule`, `/api/airing`, `/api/az-list/:letter`, `/api/filter`,
`/api/genre/:genre`, `/api/type/:type`, `/api/status/:status`,
`/api/seasons/:slug`, `/api/watch-order/:slug`, plus `/api/search`,
`/api/meta/season`, `/api/meta/recommendations` and every row inside object
payloads (home sections, top-ten `{today,week,month}`) — now emits the SAME
core field set as the detail endpoints: `key slug anilistId malId title
titleRomaji titleEnglish titleNative synonyms poster cover type season year
episodes status score rating genres description artSource`. Detail resources
(`anime` blocks) add `banner backdrop logo synopsis`.

### Fixed
- **top-ten / trending-sidebar lost every title.** Upstream rows carry the
  display title as `name`, not `title`; `catalogListItem` read only `title`,
  so 100% of rows rendered with `title: ""`. Now `title || name`. `rank`
  (dropped before) rides along on every ranking row.
- **`titleNative` was polluted with romaji.** Upstream `japaneseTitle` is the
  ROMAJI alt title (verified live: "Mushoku Tensei III: Isekai Ittara Honki
  Dasu"); it used to be copied into `titleNative` too, so every browse row
  showed a fake "native" title. It now feeds `titleRomaji` only.
- **schedule/airing rows had no art and no airing info.** Upstream schedule
  rows carry no poster — the enrichment chain fills posters via Kitsu (11/12
  on the live schedule at release time). The upstream `time`/`episode_no`
  fields, previously dropped entirely, are now `airingTime`/`airingEpisode`.
- **spotlight rows lost `description`/`date`/`quality`** — now carried
  (`date` → `releaseDate`; the `.desc` container is currently empty upstream,
  so `description` stays honestly `""`).
- **upcoming rows lost `type`** — the upstream homepage layout moved the type
  into `.meta .right`; the extractor's old selectors matched nothing. Fixed
  selector (`releaseDate` remains genuinely absent upstream — verified against
  the live page, not fabricated).
- **`/api/random` leaked the raw extractor object** — it now returns the full
  canonical detail shape (with detail-level art enrichment). Filter params it
  cannot honour come back in `ignoredParams[]`.
- **`/api/type/:type` & `/api/status/:status` 502'd on unknown values** —
  routed through the allow-empty wrapper (200, count 0).
- **`/api/recently-updated?tab=` silently accepted garbage** (returned the
  "all" view) — now 400s with the valid values (`all|sub|dub`).
- **`/api/top-rankings?sort=` silently accepted garbage** — unknown values are
  reported in `invalidParams[]` and the default (`top`) applies; valid sorts
  documented as `top|week|month` (were misdocumented as `most-favorite`).
- **One status/type vocabulary.** AniList enums (`RELEASING`, `FINISHED`,
  `MOVIE`, `TV_SHORT`, …) and lane strings now normalize to one vocabulary on
  every surface (`Currently Airing`, `Finished Airing`, `Not Yet Aired`,
  `Cancelled`, `On Hiatus`; `TV`, `TV Short`, `Movie`, `OVA`, `ONA`,
  `Special`, `Music`). Unknown vocabularies pass through untouched.
- **Cross-surface poster agreement.** Search results now prefer the primary
  lane's listing art (what browse rows and slug-keyed detail views show);
  AniList's cover is the fallback. `/api/anime` vs `/api/meta` for the same
  key are field-for-field identical (verified), and `/api/anime` now top-ups
  the canonical entry with AniList detail (synopsis/genres/score/season) so
  the two detail surfaces carry the same depth.
- **Duplicate rows on a page** (upstream layouts occasionally repeat a
  listing) are deduped per page by slug.
- **`/api/anime/episodes` thumbnails** no longer blindly fall back to the
  series poster: the enrichment chain tries upstream → Kitsu → TMDB first;
  `thumbSource` per episode reports `upstream | kitsu | tmdb | poster | null`.

### Added — the art-enrichment chain (`src/core/enrich.js`)
- **One chain, every surface**: upstream → **Kitsu** (keyless; `malId →
  /mappings` first, title-search fallback; per-season split respected) →
  **TMDB** (optional, keyed; `extractSeasonHint()` maps "… Season 3"/"… II"
  to the base show + season, prefers animated + Japanese-origin results,
  season-specific posters first, `expectedAired` air-date tolerance rejects
  wrong episode matches on split-cour shows).
- `artSource` on every anime entry: `upstream | kitsu | tmdb | null`;
  per-response `enrichment.coverage` blocks feed the test surface.
- **Failure isolation**: every provider call is caught + time-capped (12 s);
  a provider can never turn a 200 into a 5xx. Verified by fault-injection
  (all provider traffic through a dead proxy + bogus TMDB key): enrichment
  degrades to explicit nulls, responses stay clean, zero unhandled errors.
- **Bounded concurrency** (`ENRICH_CONCURRENCY`, default 8, max 16) — lists
  are enriched in parallel waves, never serialized.
- **Caching**: providers keep their internal 24 h TTL; the chain adds a 6 h
  front cache + in-flight dedup so parallel requests share one fetch.
- **`TMDB_API_KEY` is optional.** Unset → TMDB is skipped silently (no log
  noise, no latency). Added to `.env.example` and the README config table.
- **Kill switches**: `&art=0` per request; `ART_ENRICHMENT=0` globally.
- `/api/chain` episode block: the requested episode's `thumbnail` now goes
  through the same chain (previously always the series poster) — read-only
  for the playback pipeline, failure-isolated, time-capped (4 s/8 s races),
  reported as an `episode-art` step. Stream resolution logic untouched.
- `/api/health` reports the enrichment state (`art`, `kitsu`, `tmdb`).

### Contract notes (intentional, documented)
- Art fields use an explicit-null policy: when no source can supply art,
  `poster` is `null` (not `""`, not missing) and `artSource` is `null` —
  clients can never see null-vs-missing divergence.
- List items now always carry `description` (`""` when no source provides
  one) and `cover`/`artSource` (explicit nulls) — additive keys.
- `/api/completed` returns the homepage "completed" section as upstream
  provides (~5 items; the upstream site has no standalone /completed page —
  pagination is a no-op on this lane).

### Verification (full report in TEST_REPORT.md)
- Per-endpoint census before (live v2.2.1) vs after (v2.3.0): title/poster/
  year/type/episodes completeness + artSource coverage per entry.
- Cross-endpoint consistency: `/api/anime` vs `/api/meta` identical for the
  same key; trending == search == detail on poster for the same title;
  status/type vocabularies aligned everywhere.
- Enrichment coverage on live data: schedule posters 0% → 92% via Kitsu;
  covers filled on browse rows without replacing upstream posters.
- Resilience suite 16/16 (season hints, bounded pool, total provider failure),
  repo self-check 30/30, Steins;Gate identity regression 13/13.

---

## [2.2.1] — 2026-09-17 · hotfix: entry numbers are identity (the Steins;Gate 0 incident)

**Reported:** "Steins;Gate and Steins;Gate 0 have the same streams — the
original Steins;Gate episodes are gone." Confirmed against live v2.2.0:
`/api/anime/episodes?key=anilist:9253` and `?key=anilist:21127` both returned
episode ids 29078–29100 (Steins;Gate 0's 23-episode listing), so the original
24-episode series was unreachable and both keys streamed the same files.

### Root cause
`titleSignature()` (src/core/titles.js) dropped **every** pure-number token
("one piece vs one piece 2023" year-noise guard), so `"Steins;Gate"` and
`"Steins;Gate 0"` collapsed to the same signature and scored similarity
**100**. Consequences: unified search merged the two shows into one entry,
and the canonical→listing matcher (`matchSlug`) saw a 100-vs-100 tie that was
decided by upstream result order — and kaze search ranks "Steins;Gate 0"
first for **both** spellings. Every scorer in the identity layer used strict
`>` comparison, i.e. kept the first candidate on ties.

### Fixed
- **`titleSignature` keeps entry numbers.** Only YEAR-like tokens (1900–2099)
  are noise now; numeric tokens are canonicalized (`"02"` → `"2"`).
  `titleSimilarity("Steins;Gate", "Steins;Gate 0")`: 100 → **62** (below the
  78 merge threshold), while `"One Piece" vs "One Piece 2023"` still merges
  at 100.
- **Exact-title tie-break everywhere.** New `pickBestBySimilarity()` /
  `titleExactness()` helpers (titles.js) — on a score tie the candidate whose
  full normalized title equals the query wins, regardless of upstream order.
  Applied at all six decision points: AniList title anchoring (`keys.js`),
  canonical→listing matching (`matchSlug`), the kaze-fallback in
  `resolveIdentity` (previously blind `results[0]`), unified-search anchoring
  (`fallback.js`), the chain slug-path anchor (previously blind
  `anilistSearch(...)[0]`), and the seasons/watch-order candidate ranking
  (`unified.routes.js`).
- **Episodes cache key bumped** (`episodes:*:v3` → `v4`) so stale
  wrong-listing payloads expire immediately on upgrade.

### Verified (probe captures in `probe/steinsgate/`)
- `episodes?key=anilist:9253` → **24 episodes, ids 1163–1186** (its own
  listing); `?key=anilist:21127` → 23 episodes, ids 29078–29100
- `watch?key=anilist:9253&ep=1` vs `?key=anilist:21127&ep=1` → **0 overlapping
  stream URLs** (was: identical streams)
- `search?q=steins gate` → two separate TV entries (2011 / 2018)
- `resolveIdentity("Steins;Gate")` → 9253, `("Steins;Gate 0")` → 21127;
  regression suite `scripts/test_steinsgate.mjs`: **13/13 PASS**
- Playback pipeline untouched — the fix is entirely in identity/listing
  selection; no extractor, resolver, proxy or download code changed.

---

## [2.2.0] — 2026-09-17 · the unified identity / catalog consistency release

Catalog, search and detail data only — the playback pipeline (`/videojs/`,
AES, CDN tokens, proxies, `/api/watch` internals, `/api/download`) is
**untouched**. This release makes every anime-shaped response come from ONE
normalization layer (`src/core/shape.js`), makes the slug a first-class
citizen, and removes AniList as a hard dependency.

### Fixed
- **One canonical anime shape everywhere.** `/api/anime`, `/api/meta`,
  `/api/resolve`, `/api/chain`, `/api/search`, `/api/suggestions`,
  `/api/meta/season`, `/api/meta/recommendations`, `/api/meta/trending` and
  every catalog endpoint (`/az-list`, `/filter`, `/genre`, `/type`,
  `/status`, `/seasons`, `/watch-order`) now emit the same core identity
  fields with the same names at the same nesting:
  `key, slug, anilistId, malId, title, titleRomaji, titleEnglish,
  titleNative, synonyms, poster, type, year, episodes, status, genres`
  (+ detail-only `banner, synopsis` on resources; extensions such as
  `sub/dub/total/rating/votes/relation/source` ride along consistently).
- **Slug always present.** A real listing slug wins; otherwise a
  deterministic title-derived slug is used. Search results now carry the
  listing `slug` (previously dropped with the internal `lanes` block), so
  any search hit can be fed to `/api/seasons/:slug`, `/api/watch-order/:slug`
  or `/api/chain?slug=`.
- **`key` always present when any identifier exists.** Resolution order
  `anilist:<id> → mal:<id> → slug`. Previously `key` was `null` whenever
  AniList was unreachable, and `/api/meta/mal` invented a key from the raw
  input string.
- **Titles containing a colon no longer 400.** `"Frieren: Beyond Journey's
  End"`, `"Re:Zero"`, … were rejected by the key parser as "unknown key
  format"; only `anilist:`/`mal:` prefixes are special now.
- **`mal:<id>` keys no longer hard-fail when AniList is down.** The identity
  degrades to MAL-only (canonical entry built from the MAL scraper) and
  playback falls back to `getSiteIdsByMal` (`ishi` lane accepts `malId`).
- **AniList outage degradation everywhere.** `canonicalFor()` now builds an
  honest degraded canonical (identity-mapper cache → MAL → listing info)
  instead of 502-ing every identity-keyed endpoint; `malId` is threaded
  through the `ishi` lane calls in `/api/anime/episodes`, `/api/anime/servers`
  and `/api/watch`.
- **Failed upstream lookups no longer cached for 24 h.** `anilistSearch` /
  `anilistById` / detail / characters / recommendations cache failures and
  empty results for only ~45 s (was: the full 24 h TTL poisoned search,
  resolve and every meta endpoint for a day after one transient outage).
- **`/api/meta/recommendations` no longer assumes AniList.** Recommendations
  merge BOTH sources (AniList GraphQL + the previously-unused MAL scraper),
  dedup by MAL id (votes ride along), and normalize to the unified shape —
  entries that only carry a MAL id keep a `mal:<id>` key, entries that only
  carry a title still resolve through their slug. Nothing is dropped for
  lacking an AniList id; `sources: { anilist, mal }` reports the raw counts.
- **Seasons / specials grouping.** `/api/seasons/:slug` and
  `/api/watch-order/:slug` now accept ANY key format (they previously only
  accepted a raw kaze listing slug — `anilist:`/`mal:`/titles 502'd);
  entries follow the unified shape, upstream numeric ids are preserved as
  `animeId` (a bare numeric `slug` would collide with the numeric-AniList-id
  key format), relation labels normalize into shared buckets
  (`prequel/sequel/specials/ova/ona/movie/sideStory/alternative/summary/
  related/trending`) and are returned in `groups`.
- **Relations graph added to detail payloads.** `/api/anime` and `/api/meta`
  now carry a `relations` block (AniList relations) grouped with the same
  buckets — prequel/sequel/specials/OVA/ONA/movie/side-story entries follow
  the unified shape and are never silently dropped.
- **Episode `thumbnail` consistency.** `/api/anime/episodes`,
  `/api/chain`'s `episode` block and `/api/watch` now all carry `thumbnail`,
  falling back to the series poster consistently for EVERY episode (no more
  null-on-some). Episode fields are now uniform:
  `number, title, titleJapanese, thumbnail, aired, filler, recap`.
- **Listing slugs with watch-path suffixes cleaned everywhere.** Catalog
  items like `tomb-raider-king-91d21/ep-1` (filter results) were leaking
  `/ep-N` suffixes into `slug`, breaking downstream `/watch/` fetches;
  all slugs are cleaned at the adapter/route boundary now.
- **Object-shaped browse payloads no longer double-nest.** `/api/seasons`,
  `/api/watch-order` (and `home`-style payloads) answered as
  `data: { data: { … } }`; `sendList` now unwraps the lane wrapper once and
  normalizes item arrays inside.
- **Title→AniList anchoring no longer trusts upstream ranking order.**
  With `perPage=1`, spin-offs/mini-animes sharing tokens could hijack the
  anchor (a slug like `frieren-beyond-journey-s-end-c6fbj` anchored to the
  "●● no Mahou" mini anime). Anchoring now ranks 5 candidates by title
  similarity and requires a confident score.

### Added
- **`src/core/shape.js`** — THE one normalization module: `canonicalAnime`,
  `animeListItem`, `episodeRecord`, `relationsBlock`, `keyForIds`,
  `titleSlug`, `cleanListingSlug`, relation-bucket normalization. One null
  policy everywhere: strings `""`, arrays `[]`, ids/numbers `null` — never
  mixed null-vs-missing.
- **`pagination` block** where upstream provides it (`/api/filter`,
  `/api/genre`, `/api/type`, `/api/status`, `/api/az-list` — `{ page,
  totalPages, hasNextPage }`; `/api/meta/season` — AniList pageInfo).
- **`ignoredParams[]`** on `/api/filter` — unknown query params are reported
  back instead of being silently swallowed.
- **`/api/az-list` validates letters** (`a-z`, `0-9`, `all`) — garbage
  letters now 400 clearly instead of bubbling up as 502s.
- **`/api/meta/season` validates inputs** — invalid season or out-of-range
  year 400s with the allowed values (previously silent empty results).
- **Sidebar caching + empty-retry** for seasons/watch-order (bounded retry
  after mirror reset; successful sidebar data cached 30 min) — bursts no
  longer degrade to empty shells, and repeated requests never re-storm the
  upstream.
- **`/api/suggestions` uses the richer extractor** (adds `japaneseTitle`,
  `sub`, `dub`) and returns the unified item shape with a `count`.

### Compatibility
- Envelope preserved everywhere: `{ success, api, kind?, count, results[] }`.
- All previously-working `key=` inputs keep working; new formats (slug,
  colon-titles, MAL-only) were added on top.
- `/api/chain`'s `anime.totalEpisodes`, `episodeTitle`, `steps`, `timing`,
  `usage`, stream blocks and probing are unchanged.
- New response fields (slug, relations, pagination, thumbnail, …) are
  additive; clients that read the old fields see the same values as 2.1.0
  (plus the consistency fixes above).

---

## [2.1.0] — 2026-09-16 · the /videojs/ stream refresh

Upstream changed how episode streams are served: the old `ajax/sources` hop
(`megaplay-1.buzz`) no longer resolves and raw `/stream/...` embed pages answer
**410 / an error page** to direct playback. This release rebuilds the whole
playback pipeline around the site's **current** `/videojs/` player and its
`getSources` API — reverse-engineered from the player itself and verified live.

### Fixed
- **Streams 410/403 → playable.** Every stream now resolves through the working
  pipeline: raw embed → `/videojs/` player → `getSources` → decrypted m3u8/mp4 →
  90-second CDN token. Verified end-to-end against the real CDN (playlist →
  variant → MPEG-TS segment).
- **`Referer` figured out for HLS/m3u8.** Token-gated CDNs (`nexabloom.top`,
  `qeltrix.top` family) reject requests without the player referer
  (`https://megaplay.buzz/`) **and** a valid `?token=`. Both are now applied
  automatically everywhere: resolver, chain probe, and all three proxies.

### Added
- **AES sources decryption** (`src/sources/kaze/helper/cdn.helper.js`):
  `getSources` answers an `enc` blob — base64url AES-256-CBC — that decrypts to
  `{"file": "<master.m3u8>"}`. Keys/IV/secret are the site's own player constants
  and are overridable via env (`MEGAPLAY_SOURCE_ENC_KEY`, `MEGAPLAY_SOURCE_ENC_IV`,
  `MEGAPLAY_CDN_TOKEN_SECRET`, `MEGAPLAY_CDN_TOKEN_TTL`) in case the site rotates them.
- **90 s HMAC CDN tokens**, re-minted automatically:
  - by the resolver when a stream is first resolved,
  - by `/api/chain`'s probe before every CDN test,
  - by `/api/proxy/hls` + `/api/proxy/video` **on every hop**, so long playback
    never dies on token expiry mid-video.
- **Friendly server codenames.** Upstream labels are mapped to codenames and
  both stay exposed everywhere servers appear:
  `Vidstream-2 → riyo`, `Vidstream-1 → kaito (beta)`, `HD-1 → hana`,
  `HD-2 → sora`, `VidCloud-1 → akira`, `VidCloud-2 → yuki`,
  `VidPlay-1 → miso`, `VidPlay-2 → kenji`, `StreamTape-1 → arashi`,
  `StreamTape-2 → taiki`; ishi channels `Stream-A/B/C → shiro/kuro/cha`.
  Unknown labels fall back to a stable alias (`srv-<hash>`).
  - One editable table: `SERVER_CODENAMES` in `src/sources/kaze/helper/cdn.helper.js`.
  - New fields in `/api/anime/servers`, `/api/watch`, `/api/chain`:
    `originalName` (raw upstream label) and `beta: true` for the site's pretest server.
- **Richer stream objects** (`/api/watch`, `/api/chain`):
  - `qualities[]` — per-variant URLs parsed from the master playlist (tokenized per variant)
  - `subtitles[]` — subtitle tracks from `getSources` (label / language / url / format / default)
  - `skipIntro` — intro/outro skip ranges (`{intro:{start,end}, outro:{start,end}}`),
    merged from both the AJAX payload and `getSources`
  - `embedUrl` — the `/videojs/` player page (iframe-able fallback) on every stream
- **Three playable URL forms per stream**: `url` (direct, tokenized) ·
  `embedUrl` (iframe) · `proxiedUrl` (same-origin CORS proxy).
- **Proxy allowlist** extended with the new stream CDNs (`nexabloom.top`,
  `qeltrix.top`); subdomains of each apex are covered.
- **Test suite** `scripts/test_streams_v2.mjs` (`npm run test:streams`): 18 live
  checks across system, discovery, servers/naming, watch (all servers × sub/dub),
  direct + embed verification, full proxy playback chain, subtitle proxy and
  `/api/chain` (probe + all=1). Run report: 17/18 pass, 11/11 critical — the one
  non-critical miss is `/api/download` upstream availability (links are
  JS-rendered upstream; pre-existing limitation, untouched by this release).

### Changed
- **`/api/docs` redesigned** — simple, professional API-reference UI:
  - fixed sidebar with grouped endpoint navigation + live search
  - compact reference cards with param tables and per-endpoint **▶ Try**
  - docked playground: Send → status/latency/size chips → syntax-highlighted JSON,
    Copy JSON, Copy as cURL, request history, Ctrl/⌘+Enter to send
  - new "How streams work" section documenting the pipeline + naming map
  - zero dependencies, auto dark mode; `docsPage.js` + `page.css.js` +
    `page.client.js` rewritten, catalog gains `STREAM_FIELDS` + `SERVER_NAMING`.
- **Auto-migration**: any legacy megaplay-family embed URL (`megaplay.buzz`,
  `vidtube.site`, `vid-tube.site`, `vidplay.site`, with or without `/videojs/`,
  `?s=tcdn|bcdn` hints included) is normalized to the working player form.
- Probe semantics unchanged but stricter in practice: token-gated URLs are
  re-tokenized before each attempt, so `refererRequired` now only fires for
  referer-only CDNs.

### Removed
- Dead `ajax/sources` resolution path (`EMBED_API_MAP` / `megaplay-1.buzz` API
  domain) — upstream is gone; it was the source of the 410s.

### Compatibility
- Response shapes only gained fields (`originalName`, `beta`, `qualities`,
  `subtitles`, `skipIntro`, `embedUrl`); nothing existing was renamed or removed.
- `resolveStreamUrl(embedUrl)` keeps its old signature (now backed by the new
  pipeline) for any code that imported it.
- Env additions are all optional with working defaults.

---

## [2.0.0] — initial public surface

- One REST surface: search, browse, metadata, playback (`/api/search`,
  `/api/anime/*`, `/api/watch`, `/api/chain`, `/api/meta/*`, `/api/proxy/*`).
- Canonical identity per anime (`anilist:<id>` | `mal:<id>` | `<id>` | title)
  with automatic romaji/English dedup.
- `/api/chain` — the one-call streaming pipeline with per-hop timing and CDN probing.
- Built-in CORS playback proxies; self-documenting `/api/docs`, `/api/docs.json`,
  `/api/openapi.json`.
