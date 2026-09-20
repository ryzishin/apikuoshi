# Changelog

All notable changes to APIKuoshi are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

---

## [2.7.1] — 2026-09-20 · efficient episodes (One Piece no longer times out)

**Goal:** `/api/anime/episodes` was timing out on long-running shows. The live
deploy at `apikuoshi-v2.onrender.com` returned 200 in 6.7 s for Frieren (28
episodes, `?art=0` 0.24 s) but never came back for One Piece (~1100 episodes)
inside Render's 120 s request window. This release removes the per-episode
HTTP N+1 that caused the cliff and adds pagination + an explicit thumbs opt-in.

### Fixed — the /api/anime/episodes cliff
- **One Piece (and every 100+ episode show) timed out.** Root cause: the
  route ran `mapPool(shaped, enrichEpisodeThumb)` after the listing lane,
  which fired ONE Kitsu HTTP request PER episode (and optionally one TMDB
  request PER episode). At ~1100 episodes and `ENRICH_CONCURRENCY=8` that
  is ~138 sequential waves of HTTP roundtrips — minutes of wall time, well
  past any reasonable request budget. Replaced by
  `enrichEpisodeThumbsBulk` in `src/core/enrich.js`, which:
    1. resolves the Kitsu anime ID ONCE,
    2. fetches the WHOLE Kitsu episode index in ONE bounded-parallel
       paginated walk (`kitsuAllEpisodes`, new in `src/core/kitsu.js`),
    3. folds each episode in-memory from that map — **zero per-episode
       HTTP on the Kitsu side**.
  For One Piece that turns ~1100 per-episode HTTP roundtrips into ~55
  page fetches run 6-wide (≈9 sequential waves) — a ~20x reduction in
  requests and a ~10x reduction in sequential waves. The whole episode
  index is cached 24 h under `kitsu:eps-bulk:${kitsuId}`. Verified live:
  anilist:21 (1178 episodes) returns in ~12 s on a cold cache, ~3 ms on
  a warm cache (was: 120 s+ timeout).

### Added — controls for the new path
- **`EPISODE_TMDB_THRESHOLD` (env, default 50).** TMDB has no bulk
  per-episode endpoint, so per-episode TMDB calls are auto-skipped when
  the episode count exceeds this threshold. The response reports
  `enrichment.coverage.tmdbSkipped: true` when the gate fired. Set to
  `0` to disable per-episode TMDB entirely; a very large number to
  always attempt it.
- **`?withThumbs=1` (alias `?thumbs=1`).** Route-level override that
  forces per-episode TMDB enrichment even on long shows. Useful for
  clients that explicitly want the long-wait path with full thumbnails.
- **`?page=N&perPage=M` pagination.** When `perPage` is supplied (1–200),
  the response carries one page plus a ready-to-use `pagination.next`
  URL pointing at the next page. Omit `perPage` to get the whole list
  (back-compat with pre-2.7.1 clients).
- **`enrichment.tmdbThreshold` and `enrichment.withThumbs`** are echoed
  on every `/api/anime/episodes` response so clients can render the
  effective enrichment policy without reading the docs.
- **`totalEpisodes`** top-level field (alongside `count`) so paginated
  responses still report the full series length.
- New `kitsuAllEpisodes(kitsuId)` exported from `src/core/kitsu.js`.
  The legacy single-episode `kitsuEpisodeData` is retained because
  `/api/chain` still uses it for ONE specific episode.

### Changed
- **Cache key bump `:v5` → `:v6`** for the episodes lane, so stale
  entries cached under the old per-episode path don't ship placeholder
  thumbnails after the upgrade.
- The episodes route's `enrichment.coverage` object gains a `tmdbSkipped`
  boolean. Existing keys (`upstream`, `kitsu`, `tmdb`, `poster`, `none`,
  `total`) are unchanged.
- The docs catalog entry for `/api/anime/episodes` now lists `page`,
  `perPage`, `withThumbs`, `art` params and a tip explaining when to
  reach for `withThumbs`.

### Migration notes
- **No breaking changes** to existing clients. Default behaviour
  (no `perPage`, no `withThumbs`) returns the full enriched list as
  before, just much faster on long shows.
- Clients that actually relied on per-episode TMDB thumbnails for shows
  longer than 50 episodes should pass `?withThumbs=1` (and budget for
  the wait — per-episode TMDB still scales linearly with episode count).
- Clients that want a guaranteed-fast list with thumbnails filled only
  from the bulk Kitsu walk should leave `withThumbs` off and use
  `?perPage=50` to chunk.

---

## [2.7.0] — 2026-09-20 · franchise graph integrity + anilist:<id> slug-collision guard

**Goal:** `/api/seasons` and `/api/watch-order` were polluted by crossover collabs
(CHARACTER / OTHER / SOURCE / COMPILATION edges in AniList's relation graph being
walked as if they were real sequel/prequel edges). This release adds an exclusion
filter to `anilistFranchise()` so crossover edges never enter the BFS walk — and
adds a slug-collision guard to `/api/anime` so an explicit `anilist:<id>` key
always returns the canonical AniList entry, even when the upstream kaze listing
has stale slug→id mappings.

### Fixed
- **`/api/seasons` and `/api/watch-order` no longer include crossover collabs.**
  AOT's franchise now correctly returns 16 entries (No Regrets OVA through Final
  Season Specials) instead of 24 (which included Anime-Gataris, Chiyuki no
  Fashion Check, Animegatari × SnK collab ONAs — all pulled in via CHARACTER
  edges). Steins;Gate returns 7 entries (Steins;Gate + its OVAs, movie, and
  Steins;Gate 0) instead of 22 (which included Madoka Magica, Phantom, Demonbane,
  SoniAni, Ultrasonico, ChäoS;Child, Magia Record — all crossover edges).
- **`/api/anime?key=anilist:<id>` now returns the canonical AniList entry.**
  Previously, when the upstream kaze catalog had a stale slug→id mapping (e.g.
  `hello-world-isbqw` mapping to anilist:206275 "Wo Zai Feitu Shijie Sao Laji"
  instead of anilist:106240 "HELLO WORLD"), the API would return the wrong
  anime's data for an explicit `anilist:106240` lookup. Now when the user
  explicitly passes `anilist:<id>`, we verify the resolved canonical entry's
  anilistId actually matches — if not, we fetch the correct AniList entry
  directly and use it as the canonical source.

### Changed
- **`anilistFranchise()` in `src/core/anilist.js`** — the BFS walk now skips
  edges whose `relationType` is in `{CHARACTER, OTHER, SOURCE, COMPILATION}`.
  These are AniList's crossover-collab edge types: CHARACTER = shared character
  cameo (e.g. Chiyuki no Fashion Check has a CHARACTER edge to AOT), OTHER =
  unspecified crossover, SOURCE = the manga/light novel (not part of the anime
  franchise), COMPILATION = recap clip-show. The filter is applied inside the
  BFS expansion loop, before a node is added to the discovered set — so crossover
  anime never enter the graph and their own edges are never walked.
- The cache key for `anilistFranchise()` now includes `:v7` so cached v2.6.x
  walks (which included the crossover entries) are not reused after deploy.
- **`/api/anime` route in `src/routes/unified.routes.js`** — added a slug-collision
  guard: when the request key is `anilist:<id>`, we compare the resolved
  `anilistId` against the requested id. If they differ (meaning the upstream
  resolver anchored to a different anime), we fetch the correct AniList entry
  via `anilistById(requestedId)` and use it as the effective canonical. The
  response's `key` and `identities` block reflect the corrected anilist id.

### Migration notes for clients
- The `relation` field on seasons/watch-order entries is unchanged (still the
  lowercase bucket: `prequel`/`sequel`/`sideStory`/`alternative`/`spinoff`/
  `special`/`ova`/`ona`/`movie`/`summary`/`parent`/`related`/`self`).
- Crossover collabs (CHARACTER/OTHER/SOURCE/COMPILATION entries) will no longer
  appear in seasons/watch-order responses. If a client was surfacing these as
  "related anime", they should switch to the `/api/meta/recommendations`
  endpoint which still includes them.
- The `source` field on seasons/watch-order responses remains `anilist-franchise`
  when the walk succeeds — clients don't need to change anything.

---

## [2.6.1] — 2026-09-19 · scraped-data reuse (the "data exists, USE it" release)

**Goal:** the user clarified what v2.6.0 missed — "we dont need to know
all anime, what im talking about is reuse of data, combine them all
extractors or anything scrapes, since some of the endpoints has data,
why dont we adopt that logic". The kaze extractors each pull a
different field subset from the SAME upstream anime (spotlight has
description+rating+quality+releaseDate; trending has total+sub+dub+
type; upcoming has releaseDate; etc.) — but no endpoint carried the
UNION of those scraped fields. v2.6.1 makes the identity index
ACCUMULATE every extractor's scraped fields by slug, so any endpoint
that touches the same slug carries the UNION — no AniList, no external
fetching, pure reuse of data the system already has.

### The bug (reproduced live before v2.6.1)

| Endpoint | Own extractor pulls | Same anime's other endpoint has |
| --- | --- | --- |
| `/api/spotlight` | rating, quality, releaseDate, sub=0, dub=0, total=0, type="" | trending has total=24, sub=23, dub=21, type=TV for the same slug — but spotlight's row never saw it |
| `/api/trending` | total, sub, dub, type, episodes | spotlight has rating=PG-13, quality=HD, releaseDate="Apr 3, 2026" — but trending's row never saw it |
| `/api/upcoming` | releaseDate, type | trending has total+sub+dub — but upcoming's row never saw it |
| `/api/home` (cross-section) | each section pulls its own subset | v2.6.0 fixed this WITHIN a single response; v2.6.1 extends it ACROSS requests via the index |

### Added — SCRAPED-DATA ACCUMULATOR in the identity index

**`src/core/identity.js`** — `newRecord()` and `rememberAnime()` now
track the upstream-scraped fields: `description`, `rating`, `quality`,
`releaseDate`, `sub`, `dub`, `total`, `airingTime`, `airingAt`,
`airingEpisode`. The "never downgrade" rule applies (the non-empty
side wins); for `sub`/`dub`/`total`/`airingAt`/`airingEpisode` the
larger value wins (so a "12 episodes" observation isn't overwritten
by a later "0 episodes" miss). `lookupAnime()` returns the accumulated
fields so the merge layer can fill them.

**`src/routes/unified.routes.js`** — `catalogListItem()` now calls
`rememberAnime(raw)` BEFORE shaping, so every kaze row's scraped
fields feed the index keyed by slug. The row's own extractor data
wins (it's applied first via the shape layer's pick); the index
only fills what THIS row's extractor didn't pull.

**`src/core/merge.js`** — `fillFromIndex()` now reads the accumulated
fields from the index and fills them on the row. The "never overwrite
non-empty with empty" rule holds — the row's own extractor data wins;
the index only fills what THIS row's extractor didn't pull.

### Verified live (the proof)

```
1. Hit /api/trending → index accumulates total=24, sub=23, dub=21, type=TV
                       for "that-time-i-got-reincarnated-as-a-slime-season-4"
2. Hit /api/spotlight → row 0 NOW carries:
   - from spotlight extractor (own):    rating=PG-13, quality=HD, releaseDate="Apr 3, 2026"
   - from trending extractor (index):   sub=23, dub=21, total=24, type=TV
   - from index accumulator:            episodes=24 (from trending's `total`)
```

No AniList calls were made. No external fetching. Just reuse of data
the system already scraped.

### Cross-request vs cross-section

v2.6.0's `crossSectionMerge()` unified fields WITHIN a single
`/api/home` response (spotlights + trending + topAiring sections in
the same payload). v2.6.1 extends the same logic ACROSS requests —
the index is the central accumulator, so even endpoints hit hours
apart benefit from each other's scraped data.

### Compatibility

- All fields are ADDITIVE — no existing field was renamed or removed.
- The "never downgrade" rule guarantees that a row's own extractor
  data is NEVER overwritten by index data (the row's source of truth
  is the page that was just scraped; the index only fills what that
  page didn't carry).
- The merge layer's AniList path (`fillFromAnilist`) still exists —
  it's the secondary fill for fields AniList knows that no kaze
  extractor pulls (anilistId, malId, year, season enum, genres,
  synonyms, nextAiringEpisode). It runs only when the index path
  didn't fill those.

---

## [2.6.0] — 2026-09-19 · the post-shape merge layer + airing countdown + advanced resolve

**Goal:** the user observed that responses from different endpoints
sharing the same anime carried NON-UNIFORM data — `/api/home` had the
same anime twice with different field richness (spotlights had
description+rating, trending had `total`, topAiring had neither); browse
rows had no anilist/mal/year/season while `/api/anime` did; the airing
countdown existed in `anilistDetail` but was dropped by `canonicalAnime`;
and the flexible resolver gave up too early on `mal:` keys. v2.6.0
closes all of those — "the data exists somewhere in the system, USE it".

### The bug (reproduced live)

| Surface | Symptom |
| --- | --- |
| `/api/home` | Same `slug` appears in `spotlights`, `trending`, and `topAiring` with three DIFFERENT field sets — `description` only in spotlights, `total` only in trending, neither in topAiring. The row in each section carried the WORST set, not the union. |
| Browse rows (`/api/trending`, `/api/popular`, `/api/filter`, …) | `anilistId`, `malId`, `year`, `season`, `score`, `genres`, `synonyms`, `nextAiringEpisode` all missing — even though `/api/anime` for the SAME slug had them. |
| `/api/schedule`, `/api/airing` | No countdown — `nextAiringEpisode` existed in `anilistDetail` but was dropped by `canonicalAnime`. Kaze's `time` string ("23:00") was never converted to a unix timestamp. |
| `/api/resolve?title=...&advanced=1` | Did not exist; `mal:<id>` keys that `canonicalFor` gave up on never tried `getSiteIdsByMal`; plain titles never tried kaze.search as a fallback. |
| `/api/watch-order/:slug` | "Related" bucket (AniList's catch-all for `OTHER`/`CHARACTER`/untyped) was always included; clients had no way to opt out. |

### Added — the POST-SHAPE MERGE LAYER (`src/core/merge.js`)

A new module runs AFTER `catalogListItem()` shapes the row and BEFORE
`finalizeItem()` enforces the null policy. For every row it:

1. **Fills from the shared identity index** (`identity.js`'s
   `lookupAnime` by slug → title → anilistId → malId — whatever it
   has). Zero upstream calls in steady state.
2. **Fills from AniList detail cache** (`anilistById`, 24h cached,
   ~60s negative-cache) — top-ups `titleNative`, `banner`,
   `nextAiringEpisode` (countdown!), `duration`, `averageScore`,
   `studios`, `trailer`, plus everything the index knows.
3. **Remembers the slug↔title pair** back into the index so the
   NEXT request benefits (the index only ever grows; it never
   fabricates).
4. **Enqueues background backfill** for rows still missing ids —
   the NEXT request for that row carries the full shape.

Bounded concurrency (`MERGE_CONCURRENCY` env, default 8) keeps a
30-row browse page from spawning 30 AniList calls in series.

### Added — CROSS-SECTION MERGE for `/api/home` (and other sectioned payloads)

When the same slug appears in multiple sections (`spotlights`,
`trending`, `topAiring`, `topTen{today,week,month}`,
`trendingSidebar{day,week,month}`), `crossSectionMerge()` walks every
section, finds shared slugs by id, and merges fields per-bucket — the
row in EVERY section now carries the UNION of fields (description from
spotlights, `total` from trending, type from topAiring), not the WORST
set. Each section in the response still has its own ordering and items,
but shared slugs point to the SAME enriched row object.

### Added — AIRING COUNTDOWN on `/api/schedule` and `/api/airing`

- **`/api/schedule?date=YYYY-MM-DD`** — date param is now properly
  threaded through `kaze.schedule(date) → extractSchedule(date)`.
  The extractor:
  * Pulls the real listing link/slug from the schedule item's `<a>`
    tag when available (was fabricated from the title — that slug
    couldn't dedupe against other browse rows).
  * Computes `airingAt` (unix seconds) from the kaze `time` string
    anchored to the requested date's UTC midnight.
  * Surfaces `airingTime` (string) and `airingEpisode` (number)
    alongside the legacy `time`/`episode_no` for shape parity with
    `/api/home` schedule rows.
- **`/api/airing`** — the ishi lane's `getSeasonNow` GraphQL query
  now asks for `nextAiringEpisode { episode airingAt timeUntilAiring }`,
  `duration`, `season` (enum) and `averageScore` straight from AniList,
  so every airing row carries the countdown natively.
- **`shapeMedia()`** carries `nextAiringEpisode`, `season`, `duration`,
  `averageScore` into the shaped entry so `canonicalAnime()`'s pick
  list picks them up.
- **`canonicalAnime()`** now picks `nextAiringEpisode`, `duration`,
  `averageScore`, `meanScore`, `popularity`, `favourites`, `studios`,
  `trailer`, `externalLinks` from the source list — they were silently
  dropped before.

### Added — ADVANCED RESOLVE on `/api/resolve?advanced=1`

`resolveFlexible(key, { advanced: true })` climbs a longer ladder:

1. Foreground `canonicalFor(key)` (unchanged).
2. Shared identity index by id → slug → title.
3a. ishi mapper `getSiteIds(anilistId)` → `{ malId, title }`.
3b. **NEW: ishi mapper REVERSE `getSiteIdsByMal(malId)`** →
    `{ anilistId, title }` — closes the "pure `mal:` key the index
    doesn't know" hole.
4. **NEW: `kaze.search(title, 5)` fallback** when both ids failed —
    picks the best by `titleSimilarity` + `titleExactness` and
    re-anchors.
5. **NEW: multi-variant title search** — tries the raw title, the
    underscore→space variant, and the dash→space variant for plain
    title inputs.
6. **NEW: backfill enqueue on miss** — the next request after a
    not-yet-known key resolves instantly through the index.

Response gains `via` (which ladder step won) and `advanced` (whether
the advanced ladder was climbed). The original 404/502 still throws
on a hard miss so the client gets an honest signal.

### Added — WATCH-ORDER RELATION FILTERS

`/api/seasons/:slug` and `/api/watch-order/:slug` accept:

- `?exclude=related,sideStory,music` — drop buckets the caller doesn't want
- `?include=prequel,sequel,movie` — keep ONLY those buckets

Default (no params): excludes `related` (AniList's catch-all for
`OTHER`/`CHARACTER`/untyped relations). Self (`relation="self"`)
always survives. The response carries a `filter` block showing what
was applied + whether the default was used.

The "Music" bucket the user mentioned doesn't actually exist today
(AniList `format: MUSIC` falls through to `related` via
`bucketForRelation`); clients who want to drop music can just
`?exclude=related`.

### Added — `?fields=` param plumbing (forward-compatible)

The merge layer accepts `?fields=` (comma-separated) on browse
endpoints. Today it's a no-op passthrough (every row already carries
every field via the merge layer); the param exists so future minor
bumps can add lazy enrichment for rarely-needed heavy fields without
changing the response shape.

### Changed

- `canonicalAnime()` and `animeListItem()` emit the new fields. They
  are NULL when no source provides them — the existing null-policy
  contract holds (strings `""`, arrays `[]`, ids/numbers `null`).
- `finalizeItem()` preserves the new fields (treats them as nullable
  or arr per the field's nature).
- `/api/health` reports `enrichment.merge: "enabled (v2.6.0 …)"`.
- `shapeMedia()` and `rememberAnime()` track `nextAiringEpisode`
  (always-overwrite — it's per-show state that mutates daily),
  `duration`, `averageScore`, `season` enum alongside the existing
  fields.
- The kaze schedule adapter signature changed: `kaze.schedule(date)`
  (was `kaze.schedule()`). Backward compatible — `date` defaults to
  today's UTC date.

### Verified (battery in `scripts/test_v260_features.mjs`)

- `/api/home` — same slug in spotlights+trending+topAiring now carries
  the UNION of fields.
- `/api/trending`, `/api/popular`, `/api/filter`, `/api/az-list/a`,
  `/api/genre/action`, `/api/type/TV`, `/api/status/airing`,
  `/api/upcoming`, `/api/completed`, `/api/new-release`,
  `/api/recently-updated` — every row that the index knows about
  carries `anilistId`/`malId`/`year`/`season`/`score`/`genres`/
  `synonyms` after the merge layer.
- `/api/schedule` — `airingAt` is present on every row; `?date=`
  threads through.
- `/api/airing` — `nextAiringEpisode` (countdown!) is present on rows
  whose AniList entry is currently airing.
- `/api/anime` and `/api/meta` for the same key — both carry
  `nextAiringEpisode`/`duration`/`averageScore`/`studios`/`trailer`
  with identical values.
- `/api/resolve?title=frieren&advanced=1` — returns `via` + `advanced`.
- `/api/watch-order/anilist:21127?exclude=related,sideStory` — those
  buckets drop from `groups`; self survives.
- `/api/watch-order/anilist:21127?include=prequel,sequel` — only
  those buckets remain.
- Regression: search, episodes, servers, watch, chain — untouched.

### Compatibility

- All existing fields keep their names and shapes; only ADDITIVE
  fields were introduced (`nextAiringEpisode`, `duration`,
  `averageScore`, `meanScore`, `popularity`, `favourites`, `studios`,
  `trailer`, `externalLinks`, `via`, `advanced`, `filter`).
- The kaze schedule adapter signature changed from `schedule()` to
  `schedule(date = null)` — backward compatible.
- The merge layer is always-on; clients that want the v2.5.2
  behaviour (no merge) can pass `?merge=0` (planned for v2.6.1).
- The playback pipeline (`/api/watch`, `/api/chain`, `/api/proxy/*`,
  subtitle conversion) is **untouched**.

---

## [2.5.2] — 2026-09-19 · watch-order fix (the "season 3 returns the whole franchise" release)

**Goal:** minor fix for the reported watch-order bug — "even if I call using
season 3 of anime it shows its watch order or release saying its a prequel or
sequel". Reproduced live against v2.5.1 before fixing.

### The bug

`/api/watch-order/:slug` and `/api/seasons/:slug` were calling
`anilistRelations(rootId)` once and returning whatever it returned. AniList
only stores DIRECT relation edges on each entry's record — the edge
"Steins;Gate → SEQUEL → Steins;Gate 0" lives on the **Steins;Gate** record,
NOT on the **Steins;Gate 0** record. So a call for the sequel/season-N
returned only that entry's own edges and **missed the parent show entirely**:

| Call (live v2.5.1)                    | Returned | Missing |
| ------------------------------------- | -------- | ------- |
| `/api/watch-order/steins-gate-0-cbge5` (anilist:21127) | 2 entries: the 23β OVA (prequel) + Valentine OVA (sideStory) | the original **Steins;Gate** (anilist:9253) — SG0's actual prequel |
| `/api/watch-order/anilist:178789` (Mushoku Tensei S3) | 1 entry: S2P2 (prequel) | S1 (108465), Cour 2 (127720), S2 (146065) |

The user-visible symptom — "the watch order says prequel or sequel" — was
correct as far as it went (those WERE the direct relation labels) but
useless: the rest of the franchise (the actual watch ORDER) was missing,
because the parent edge was on the predecessor's record, not the successor's.

### Fixed

- **NEW: `anilistFranchise(rootId)` in `src/core/anilist.js`.** BFS walk of
  the AniList relations graph up to depth 3 / 40 nodes. For each discovered
  node it infers its relation to ROOT:
  * direct root edge wins (root's own label for this neighbor)
  * pure PREQUEL/PARENT chain → "PREQUEL"
  * pure SEQUEL chain → "SEQUEL"
  * anything else → the immediate edge type (SIDE_STORY, SPIN_OFF, …)
  Each BFS level is fetched in parallel (batch of 8); 6h cache TTL on the
  franchise result, with the usual ~60 s empty-cache fallback.
- **`/api/watch-order/:slug` now returns the COMPLETE franchise.** New
  fields:
  * `watchOrder[]` — every entry **INCLUDING the queried anime** (marked
    `relation: "self"`) sorted by release year ascending; each entry
    carries `releaseOrder` (1-based position).
  * `rootReleaseOrder` — the queried anime's own `releaseOrder` (so a
    client can render "S1 → S2 → S3 → **you are here** → S4").
  * `root` — the queried anime (relation="self").
  * `totalInFranchise` — full count (root + relations).
  * `releaseOrder` is also placed on every entry in `related[]` (additive;
    no existing field was renamed or removed).
- **`/api/seasons/:slug` now walks the franchise transitively too** — every
  season of the franchise comes back regardless of which entry was keyed
  on. Adds a `root` field (the queried anime) for parity with watch-order.
- **`?deep=0` opt-out.** Both endpoints accept `?deep=0` to keep the
  v2.5.1 behaviour (only AniList's direct relations of the queried entry).
  Default is `deep=1` (full franchise walk).

### Verified (battery in `scripts/test_v252_features.mjs`)

- `watch-order/anilist:21127` (Steins;Gate 0) — now returns 6+ entries
  including the original Steins;Gate (9253); `rootReleaseOrder` matches
  SG0's position in the release-year sequence.
- `watch-order/anilist:178789` (Mushoku S3) — now returns the full
  Mushoku franchise (S1, Cour 2, S2, S2P2, S3); releaseOrder 1..5.
- `watch-order/anilist:9253` (the original Steins;Gate) — same franchise
  set (just from the other side); demonstrates symmetry of the walk.
- `?deep=0` — falls back to v2.5.1 behaviour (only direct edges).
- `seasons/anilist:178789` — same expanded set under the seasons shape;
  `root` populated with the queried anime.
- Regression: search, anime, watch, home still 200 OK and untouched.

### Compatibility

- All existing fields on both endpoints keep their names and shapes; only
  ADDITIVE fields were introduced (`watchOrder`, `releaseOrder`,
  `rootReleaseOrder`, `root`, `totalInFranchise`, `franchiseHops`). The
  `related[]` array GAINED entries (the missing franchise), which is the
  whole point of the fix — clients that read the array positionally will
  see more rows, but no row lost a field or had one renamed.
- The kaze-sidebar fallback path is unchanged; it only runs when AniList
  is unavailable or returns no edges at all.
- The playback pipeline (`/api/watch`, `/api/chain`, `/api/proxy/*`,
  subtitle conversion) is **untouched**.

---

## [2.5.1] — 2026-09-18 · core + identity bug-fix (search / suggestions / resolve)

**Goal:** minor-fix release for the core+identity surface. Every reported bug was
first REPRODUCED live against v2.5.0 before being fixed — verification batteries
46 checks pre-fix, 49 checks post-fix.

### Fixed
- **`/api/suggestions` now returns the SAME data as `/api/search`.** In v2.5.0
  the two endpoints ran different pipelines (kaze typeahead vs the unified
  search) and could disagree for the same term — different counts (3 vs 6 for
  "frieren"), different title spellings ("Dandadan" vs "DAN DA DAN") and even
  conflicting AniList ids for the same slug (206425 vs 170068). Suggestions now
  run through the identical `unifiedSearch` → shape → enrich pipeline (shared
  upstream cache, zero extra cost) and expose the same results array under BOTH
  `suggestions` (typeahead key) and `results` (/api/search parity key). Every
  entry carries the full identity block — `key`, `slug`, `anilistId`, `malId`,
  titles — merged in, never null. New `?limit=` trims the tail for typeahead
  UIs; `?page=` is supported; `q`/`query` are aliases of `keyword`.
- **`/api/resolve` accepts ANY key.** Four classes of previously-failing input
  now resolve:
  * dedicated param names — `?slug=` `?anilist=` `?mal=` `?id=` (v2.5.0 only
    read `title|q|key`; the rest 400'd). Scheme-named params pin the scheme:
    `?mal=50265` is read as `mal:50265`, not as a bare AniList id;
  * `slug:<slug>` prefixed keys — previously 404 (only `anilist:`/`mal:`
    prefixes were parsed);
  * pasted URLs — `https://anilist.co/anime/154587`,
    `https://myanimelist.net/anime/50265` and any watch-site URL with a
    `/watch/<slug>` (or `/anime|title|series/<slug>`) segment resolve to their
    canonical key (new `keyFromUrl()` in `src/core/keys.js`);
  * native-script titles — `葬送のフリーレン` anchored to the WRONG AniList
    entry (a mini-anime) because the anchor scorer never compared
    `titleNative`; CJK input scored ~0 against romaji/English titles and raw
    AniList search order decided. `titleNative` now joins the scorer
    (`anchorTitleToAnilist`, `anchorTitleToAnilistQuiet`) and the exactness
    tie-break in `pickBestBySimilarity`, so the main series (154587) wins.
- **`normalizeRelation is not defined` 500s** on `/api/seasons/<slug>` and
  `/api/watch-order/<slug>` (latent v2.5.0 import bug — the untyped-relation
  branch referenced a symbol that was never imported). Added to the shape.js
  import list; both endpoints verified live (10 relations each).

### Verified clean (no bug found)
- `/api/search` itself: `q`/`keyword`/`query` aliases, dedup, identity block,
  art contract, honest 404s — all correct in v2.5.0; untouched apart from the
  shared-pipeline refactor.

### Compatibility
- Additive only. `suggestions[]` keeps its name (content upgraded); `results`
  is a new alias on that endpoint; `/api/resolve` responses keep their shape;
  VTT/subtitle/proxy behavior from 2.5.0 is unchanged.

---

## [2.5.0] — 2026-09-18 · proxy hardening, subtitle format conversion, flexible identity keys

**Goal:** make the playback infrastructure survive real-world CDNs and real-world
identities. The three `/api/proxy/*` endpoints were failing (403) for any caller
who did not already know to pass `&ref=https://megaplay.buzz/` — and the subtitle
proxy could only echo bytes, while upstream tracks arrive in VTT *and* SRT.
On the identity side, `anilist:<id>` / `mal:<id>` keys 404/502 whenever AniList
rate-limits or the id is not indexed upstream, while the listing **slug** always
resolves. This release fixes both classes of failure — tested live end-to-end
(master playlist → variant → segment, and VTT ⇄ SRT conversion against real
subtitle CDNs).

### Added
- **`/api/proxy/subtitle` — format-aware subtitle restreamer.** The source
  format is SNIFFED from the payload (`vtt` / `srt` / `ass`), never guessed from
  a file extension (CDNs disguise payloads). `?format=srt` serves SubRip
  (WebVTT sources are converted: WEBVTT/NOTE/STYLE blocks stripped, cue
  settings dropped, counters renumbered, dot-millis → comma-millis);
  `?format=vtt` stays the **default** so existing `<track>` consumers are
  unaffected (`&raw=1` skips conversion entirely). Response headers
  `X-Subtitle-Source-Format`, `X-Subtitle-Format`, `X-Subtitle-Converted`
  report exactly what happened. Conversion lives in the new dependency-free
  `src/core/subtitles.js` (`detectSubtitleFormat`, `srtToVtt`, `vttToSrt`,
  `convertSubtitle`) — 19 unit tests, idempotent, never throws on weird input.
- **Subtitle proxy data in the API responses.** Every subtitle track returned
  by `/api/watch` and `/api/chain` (in `streams[]` and in the winner `best`)
  now carries `proxiedUrl` (same-origin WebVTT) **and** `proxiedSrtUrl`
  (same-origin SubRip) next to the upstream `url` — clients pick the rendition
  they need without building proxy URLs by hand.
- **`identities` block on every detail response** (`/api/anime`,
  `/api/anime/episodes`, `/api/anime/servers`, `/api/watch`, `/api/download`,
  `/api/chain`): `{ preferred, slug, anilistId, malId, keys }` — `preferred`
  is the SLUG-first key clients should feed other endpoints, `keys` exposes
  every scheme (`slug` / `anilist:…` / `mal:…`) so clients can switch identifier
  forms silently when one is not indexed. `/api/anime`'s `endpoints` map and
  `/api/chain`'s `usage` URLs are now built with the slug-preferred key.
- **`?slug=` accepted everywhere `?key=` is.** All key-driven endpoints
  (`/api/anime`, `/api/anime/episodes`, `/api/anime/servers`, `/api/watch`,
  `/api/download`, `/api/meta*`, …) accept `?slug=<listing-slug>` as a
  first-class alias — slugs are the one address the upstream catalog always
  understands.
- **`resolveFlexible()` — the silent identity fallback ladder**
  (`src/core/keys.js`). Wrapped around every key-driven endpoint and the chain
  resolver: when `canonicalFor` fails with 404/502, the ladder climbs
  (1) the shared identity index by id → slug/title, (2) the ishi mapper
  (anilistId → malId/title → MAL details), (3) a direct listing-slug rebuild —
  so id keys that are not indexed upstream (AniList outage, rate limit, mapper
  cache cold) still resolve instead of erroring. Original errors are preserved
  when nothing can rescue them.

### Changed
- **REFERER-DEFAULT on all three proxies** (`/proxy/hls`, `/proxy/video`,
  `/proxy/subtitle`): the megaplay CDN family (anipixcdn/nexabloom/qeltrix/
  zhaevor/quavex…) answers **403** to any fetch without their player Referer.
  The proxies now send `STREAM_PROXY_REFERER` (default `https://megaplay.buzz/`)
  when no `&ref=` is given; `&ref=none` explicitly sends no Referer; any other
  value overrides. Each handler also retries once through the Referer ladder on
  upstream 401/403, so a stale client-supplied ref can never kill a playable
  request. HLS playlist rewrites propagate the referer policy that actually
  worked to every child hop. Verified live: subtitle/HLS/segment fetches went
  403 → 200 with zero client changes.
- **CDN token re-mint fix** (`src/sources/kaze/helper/cdn.helper.js`):
  `withCdnToken` used to APPEND a fresh `?token=` after a stale one
  (`…&token=STALE&token=FRESH`) — the CDNs (and our own freshness check) read
  the FIRST token param, so replaying an older `/api/chain` response after the
  90 s TTL kept 403-ing forever. Existing tokens are now stripped before a
  fresh one is minted. Replayed stale-token playlists verified 403 → 200.
- **`matchSlug` multi-query matching** (`src/core/keys.js`): upstream search
  indexes are spelling-sensitive, so the listing matcher now tries EVERY
  distinct seed — romaji, English title, slug-derived — and keeps the
  best-scoring listing across all of them (early exit at ≥ 95 confidence).
  Directly cuts the "not found upstream" class of 404s for id-keyed requests.
- **Proxy allowlist refreshed**: `zhaevor.top` (subtitle tracks) and
  `quavex.top` (media segments) observed live during the v2.5.0 test pass and
  added to `DEFAULT_PROXY_DOMAINS` (relevant when `STREAM_PROXY_DOMAINS`
  enforcement is in play).
- **`/api/docs` + README** updated for the new proxy contract (formats,
  referer default, `raw`, identity block).

### Fixed
- **Route collision on `/api/download` (v2.4.0 regression in route assembly).**
  The source-ZIP handler was mounted at BOTH `/download` and `/api/download`
  (system router), and since the system router mounts first it shadowed the
  documented `/api/download?key=…&ep=1` EPISODE-links endpoint — clients got
  a ZIP 404 (or the binary!) instead of download data. The ZIP now lives
  only at top-level `/download`; `/api/download` serves episode links again.
- Stale-token replay 403 (see above) — previously every proxied replay of a
  response older than 90 s was unrecoverable.
- `/api/watch?slug=…` previously 400-ed ("Provide ?key=") despite slugs being a
  documented key format.
- `/proxy/subtitle` no longer guesses the format from the URL — a `.srt`-named
  VTT payload (or vice versa) is detected from its bytes before converting.

### Verified live (v2.5.0 test pass)
- Subtitle proxy: no-ref 403 → **200**; `format=srt` conversion VTT → SRT
  (19613 B, counters + comma-millis); `raw=1` passthrough; `ref=none` rescued
  by the retry ladder.
- Full HLS chain with zero client-side refs: master playlist (593 B) → variant
  (68 541 B) → segment (809 528 B, valid MPEG-TS `0x47` sync byte).
- Identity: `/api/watch?slug=…` serves the full payload; `identities.preferred`
  slug-first; subtitle tracks carry both proxied renditions; `/api/chain`
  returns `identities` + `best.subtitles`.

---

## [2.4.0] — 2026-09-17 · data completeness, true relations, responsive docs, performance pass

**Goal:** kill every hollow `200 OK`. A `200` with missing `anilistId` / `malId` /
`slug` / `year` / `status` / `genres` / `synonyms` is a failure, not a success —
the data existed in the system, it just was not shared. This release shares it
(`src/core/identity.js`), rebuilds `/api/seasons` + `/api/watch-order` on the
AniList relations graph so only true relations come back, makes `/api/docs`
fully responsive at 320/375/414 px, and cuts list-endpoint latency from seconds
to single-digit milliseconds on warm paths. Streams untouched.

### Added
- **`src/core/identity.js` — THE SHARED IDENTITY INDEX.** One cross-endpoint
  record of everything the process has already resolved about an anime
  (ids, titles, synonyms, genres, year, episodes, format, status, poster),
  keyed by every address it is known under (`a:<anilistId>`, `m:<malId>`,
  `s:<slug>` including stale slugs, `t:<normalized title>`). Fed by AniList
  search/byId/detail/relations, MAL details, kaze listing pages, search
  anchoring and slug resolution; consulted by every list/detail surface.
- **Background identity backfill queue** — catalog rows that no endpoint has
  resolved yet are anchored in the background (bounded: concurrency 2,
  ≥1.2 s spacing, ≥ dedup-threshold confidence gate, `IDENTITY_BACKFILL=0`
  kill switch) so the NEXT request carries the complete shape. Responses are
  never blocked by it; unknowns stay explicit `null`s — nothing is invented.
- **`GET /download`** — serves the full source ZIP (`KUOSHI_ZIP_PATH` env,
  repo-root `apikuoshi-<version>.zip`, or `../download/`); clean JSON 404 when
  no archive is deployed. Linked from the landing JSON, the docs hero button
  and the docs footer.
- **`identityIndex` stats in `/api/health`** — indexed anime / key count, next
  to the cache stats.

### Changed — data completeness (§1)
- **Every anime-shaped entry now carries `anilistId`/`malId`/`year`/`status`/
  `type`/`episodes`/`genres`/`synonyms`/`title*` whenever ANY sibling endpoint
  of the same process has resolved them.** The completeness pass runs inside
  the canonical builder path (`catalogListItem` → `applyIdentityIndex`) and
  also upgrades `key` to the `anilist:` / `mal:` form per the documented key
  precedence. First hit on a cold process still shows honest `null`s; the
  backfill fills them for every request after.
- **Stale-slug resolution (slug repair).** Upstream discovery pages keep slugs
  whose `/watch/` pages are gone (`frieren-odmau` → 404 upstream while search
  carries `frieren-beyond-journey-s-end-c6fbj`). `resolveSlugIdentity` now
  retries progressively shortened seeds, anchors the top candidates (not just
  rank #1), re-ranks by title similarity to the franchise query and penalizes
  season-decoration mismatches (a bare `*-odmau` slug no longer anchors to a
  "Season 2"). Result: `/api/anime?key=frieren-odmau` went from **404 in ~25 s**
  to **200 in ~1.5 s** with the full canonical shape; `/api/resolve` succeeds
  for every entry any endpoint returns.
- **Apostrophe-glued title anchoring** — `"Koala's Diary"` searched as
  `"koala s diary"` finds nothing on AniList (the lone `s` poisons matching);
  the glued variant `"koalas diary"` does. Applied to foreground and
  background anchoring.
- **MAL-only keys are enriched, not thin.** `malCanonical` now merges the
  identity index and a bounded AniList title anchor, so `mal:52991` returns
  `anilistId`, synonyms, genres and year when the system knows them.
- **Detail surfaces agree with browse rows.** `publicAnime` prefers the
  listing slug the request arrived by (id-keyed requests use the best-known
  listing slug from the index), so `/api/resolve` of a browse entry returns
  THAT entry's address instead of a divergent title-derived slug.
- **AniList steady retries** — `anilistById` and `anilistSeason` retry a
  transient 429/timeout once instead of surfacing a 500/502/hollow-empty
  (`/api/meta/season` empty-result negative-cache stays 45 s).
- **Mirror helper: a legit 404 no longer poisons the mirror pool.** Axios
  rejected 404s before the "Endpoint not found → don't mark the mirror failed"
  branch could run, so ONE stale slug marked every mirror failed and broke
  unrelated endpoints for the whole session. Root cause of the ~25 s slug
  failures; now 404s are handled as designed (no mirror penalty, no retries).
- **Relation buckets renamed to ONE vocabulary** (shape.js `normalizeRelation`
  + new `bucketForRelation`): `prequel, sequel, sideStory, alternative,
  spinoff, special, ova, ona, movie, summary, parent` (+ `related` for generic
  CHARACTER/OTHER/SOURCE edges, bucketed by format when the node has one).
  v2.3's `specials` and `trending` buckets are gone; `trending` rows were
  never relations. Rule: a typed relation always wins; generic relations fall
  back to the node format.

### Fixed — `/api/seasons/:slug` + `/api/watch-order/:slug` (§2)
- **True relations only.** Both endpoints now derive their relation set from
  the **AniList relations graph** (typed edges — same franchise by
  construction, every entry justified by the source). The kaze watch-page
  sidebar is now only a fallback, STRICTLY franchise-filtered (shared title
  root / slug root) and relation-labelled — the v2.3 bug where unrelated
  seasons, wrong sequels/prequels and stray specials leaked in is gone.
  Measured on `steins-gate-odmau`: v2.3 returned 22 entries with 21
  suspicious; v2.4 returns 8 entries, 0 suspicious, grouped
  `sequel / sideStory / alternative / ona / related`.
- **`watch-order` no longer returns the trending sidebar.** v2.3's fallback
  literally scraped the "Trending" section and labelled it
  `relation: "trending"`. v2.4 emits the true-relation set in a canonical
  sequence (`prequel → parent → sequel → sideStory → spinoff → movie → ova →
  ona → special → summary → alternative → related`) with an `order` index on
  every entry. New `source` field on both endpoints says where the relation
  set came from (`anilist-relations | kaze-sidebar`).
- Both endpoints keep the v2.3 envelope
  (`success, api, kind, key, slug, totalSeasons|totalRelated, count,
  seasons|related, data{...}`) and add `groups` + `source`.

### Fixed — `/api/docs` responsive UI (§3)
- **Sidebar is a drawer below 1080 px** (was `display:none` — navigation
  unreachable on mobile): hamburger in the topbar, slide-in panel, dimmed
  backdrop, Esc/backdrop/nav-tap to close, `aria-expanded` wired.
- Endpoint cards stack (method + ▶ Try on row one, path wraps below),
  parameter/field tables scroll inside their cards, playground URL row wraps
  and Send becomes full-width, status/latency chips and Copy JSON / Copy as
  cURL wrap without clipping, quickstart chips ellipsize, footer stacks.
- Verified headless at **320 / 375 / 414 px**: zero horizontal overflow
  (`scrollWidth == clientWidth` at all three), drawer reachable, tables within
  viewport.

### Performance (§4)
- **Browse TTL cache** (`BROWSE_CACHE_SECONDS`, default 120 s) — v2.3
  re-scraped upstream on EVERY browse request. Keys are canonical
  (lower-cased, param-order independent); `/api/random` is never cached.
  Warm browse latency: 841–3 468 ms → **2–50 ms**.
- **Cache-stampede dedup** — `withCache` / `withCacheOk` share one in-flight
  run per key; parallel cold requests for the same resource now perform ONE
  upstream fetch (reported in `/api/health` as `cache.inflight`).
- **List art-enrichment skip + deadline** — items whose art is already
  present from upstream skip Kitsu/TMDB entirely in list mode (the per-item
  cover hunt was the largest list-endpoint latency cost; cover stays
  best-effort and explicit-null per the v2.3 contract, detail mode keeps the
  full chain), and list enrichment respects a wall-clock deadline
  (`ENRICH_DEADLINE_MS`, default 4 s) so a slow provider can never hold a
  response hostage. `ENRICH_CONCURRENCY=8` unchanged; TMDB remains skipped
  when `TMDB_API_KEY` is unset (verified).
- **Parallel lanes verified** — `SOURCE_PRIORITY` ordering still
  short-circuits on first success; `unifiedSearch` now fires the AniList
  canonical query in parallel with the lane queries instead of awaiting it
  first.
- **Search anchoring feeds the index** — every anchored search row remembers
  its slug ↔ identity link, so the first `/api/search` warms the whole surface.
- Measured (same host, warm): browse family 2–50 ms (v2.3: 19–73 ms warm,
  0.1–7.0 s cold); `/api/anime` by stale slug 24 892 ms → 1 458 ms;
  `/api/resolve` by slug 11 542 ms → 1 269 ms. Full table in
  [TEST_REPORT.md](TEST_REPORT.md).

### Compatibility
- Envelopes preserved (`{ success, api, kind, count, results[] }`, object
  payloads via `data{}`); all existing key formats keep working; the v2.3 art
  contract (`artSource`, `thumbSource`, explicit `null`s) is intact.
- Breaking-ish (documented): relation bucket `specials → special`, `trending`
  bucket removed; `seasons[].relation` is new on `/api/seasons` entries;
  `groups` is new on `/api/seasons`.

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
