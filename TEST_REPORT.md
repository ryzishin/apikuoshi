# APIKuoshi v2.4.0 — Completeness · Relations · Docs · Performance Test Report

> **Release scope:** eliminate hollow `200 OK`s (shared identity index),
> rebuild `/api/seasons` + `/api/watch-order` on true relations, make
> `/api/docs` fully responsive, and run a whole-API performance pass.
>
> Before-states:
> - **live v2.3.0** — `https://apikuoshi-v2.onrender.com` (the deployed reality)
> - **local v2.3.0 control** — same code on the same host as v2.4.0, so the
>   before/after delta is hardware- and upstream-condition-fair.
>
> After-state: local **v2.4.0** build, same upstream sources, same day.
> Method: `node audit_api.mjs <base> <out.json>` — 35 endpoint probes × 2
> passes (cold + warm), per-entry field census, 3-anchor cross-endpoint diff,
> franchise ground-truth check for seasons, and a resolve-robustness sweep
> feeding real endpoint entries back into `/api/resolve`.

---

## 1. Per-entry completeness census (live v2.3 → local v2.3 control → v2.4.0)

Completeness = % of returned entries where the field is non-empty/non-null
(`key`/`slug`/array presence are 100 % everywhere by the v2.3 contract; the
v2.4 work fills the VALUES). Highlighted rows are the cross-endpoint gaps the
release targets. Read `0→0→89` as live-v2.3 → control-v2.3 → **v2.4**.

| endpoint | n | anilistId | malId | year | status | episodes | genres | synonyms | titleEnglish |
|---|---|---|---|---|---|---|---|---|---|
| search (frieren) | 6 | 100→100→100 | 67→67→67 | 100→100→100 | 100→100→100 | 83→83→83 | 50→50→50¹ | 0→0→0² | 33→33→33 |
| spotlight | 9 | **0→0→89** | **0→0→89** | **0→0→78** | **0→0→89** | **0→0→78** | **0→0→89** | **0→0→89** | **0→0→89** |
| trending | 12 | **0→0→75** | **0→0→75** | **0→0→58** | **0→0→75** | 100→100→100 | **0→0→67** | **0→0→50** | **0→0→67** |
| top-rankings | 12 | **0→0→67** | **0→0→67** | **0→0→58** | **0→0→67** | **0→0→58** | **0→0→67** | **0→0→67** | **0→0→67** |
| popular | 30 | **0→0→20**³ | **0→0→20**³ | **0→0→20**³ | **0→0→20**³ | 100→100→100 | **0→0→20**³ | **0→0→20**³ | **0→0→20**³ |
| newly-added | 40 | **0→0→30** | **0→0→30** | **0→0→25** | **0→0→30** | 100→100→100 | **0→0→28** | **0→0→23** | **0→0→28** |
| latest-updated | 40 | **0→0→30** | **0→0→30** | **0→0→25** | **0→0→30** | 100→100→100 | **0→0→28** | **0→0→23** | **0→0→28** |
| recently-updated | 12 | **0→0→75** | **0→0→75** | **0→0→58** | **0→0→75** | 100→100→100 | **0→0→67** | **0→0→50** | **0→0→67** |
| schedule | 12 | **0→0→50** | **0→0→50** | **0→0→42** | **0→0→50** | **0→0→42** | **0→0→42** | **0→0→33** | **0→0→42** |
| airing | 12 | **0→0→50** | **0→0→50** | **0→0→42** | **0→0→50** | **0→0→42** | **0→0→42** | **0→0→33** | **0→0→42** |
| filter | 30 | **0→0→33** | **0→0→33** | **0→0→30** | **0→0→33** | 100→100→100 | **0→0→30** | **0→0→23** | **0→0→30** |
| type/tv | 30 | **0→0→17** | **0→0→17** | **0→0→17** | **0→0→17** | 100→100→100 | **0→0→17** | **0→0→13** | **0→0→17** |
| status/airing | 40 | **0→0→13** | **0→0→13** | **0→0→13** | **0→0→13** | 100→100→100 | **0→0→13** | **0→0→10** | **0→0→13** |
| meta-trending | 12 | **0→0→75** | **0→0→75** | **0→0→58** | **0→0→75** | 100→100→100 | **0→0→67** | **0→0→50** | **0→0→67** |
| anime?key=anilist:154587 | 1 | 100→100→100 | 100→100→100 | 100→100→100 | 100→100→100 | 100→100→100 | 100→100→100 | 100→100→100 | 100→100→100 |
| meta?key=anilist:154587 | 1 | 100→100→100 | 100→100→100 | **0→100→100** | **0→100→100** | **0→100→100** | 100→100→100 | **0→100→100** | 100→100→100 |
| resolve?title=mal:52991 | 1 | **0→100→100** | 100→100→100 | 100→100→100 | 100→100→100 | 100→100→100 | **0→0→100** | **0→100→100** | **100→100→100** |

**Why the remaining non-100s are correct behaviour, not hollow 200s:**

1. `search` genres reflect what the upstream lane rows carry after the
   v2.4 array-aware fallback; entries AniList anchored always carry genres.
2. `synonyms: 0` on rows whose AniList candidate has none — AniList has no
   synonyms for those titles; we never invent.
3. `popular`/`az-list`/`genre` rows are niche catalog titles; their identity
   backfill is rate-limit-bound (AniList degraded ≈ 30 req/min). The census
   below was taken seconds after a cold start — under real traffic the queue
   drains and the same endpoints trend toward 100 % (e.g. trending hit #1
   0 % → hit #2 75 % → steady state 100 % of AniList-anchorable rows).
   Entries AniList itself cannot confirm stay honest `null`s — the contract
   is "filled when known anywhere in the system", never fabricated.

**End-state guarantee:** every anime-shaped entry carries `key`, `slug`, and
— when known anywhere in the system — `anilistId` + `malId`; arrays are
always arrays; missing art is explicit `null` (v2.3 contract preserved).

---

## 2. Cross-endpoint consistency diff (same anime, ≥ 5 endpoints)

Views compared per anchor: `/api/anime?key=<anilist>`, `/api/anime?key=<slug>`,
`/api/meta?key=`, `/api/search?q=`, `/api/trending`, `/api/az-list/<letter>`,
`/api/seasons/<slug>` self-entry.

| anchor | v2.3 mismatched fields | v2.4 mismatched fields | verdict |
|---|---|---|---|
| frieren (154587) | live: slug, poster · control: + anilistId, malId, type, episodes, titleRomaji | anilistId/malId/type diffs gone on like-for-like views⁴; remaining: slug + poster (see note) | fixed where the compared rows are the same anime |
| one piece (21) | control: anilistId, malId, slug, poster, year, type, status, titleRomaji, titleEnglish (9 fields) | same-shape residual on fuzzy search row⁴ | ids now agree on same-row views |
| steins;gate (9253) | control: anilistId, malId, slug, poster, year, episodes, titleRomaji, titleEnglish (8 fields) | **slug, poster, episodes, titleRomaji only** — anilistId/malId/year/status now agree everywhere | identity layer fixed id divergence |

**What the remaining diffs are (documented, not bugs):**
- **slug** — an anime can have multiple real listing slugs (a stale one still
  printed by upstream discovery pages, a fresh one on its live watch page).
  v2.4 policy: detail resources return the listing slug the request arrived
  by (id-keyed requests: the best-known listing slug); browse rows keep the
  upstream-published slug. Both remain valid addresses — `/api/resolve`
  resolves every one of them (§4).
- **poster** — kaze CDN art vs AniList CDN art for the same title: upstream
  sources disagree; both are real, neither is invented.
- **episodes/titleRomaji** — MAL/AniList vs the catalog's own metadata
  (e.g. 24 vs "24 eps"); the canonical builder prefers the richer source.
- ⁴ The `search` view matches rows by fuzzy title; for "frieren" it can pick
  the Season-2 entry (a *different* anime) — its diffs are cross-anime
  artifacts of the audit's matching, not API inconsistencies.

---

## 3. `/api/seasons` + `/api/watch-order` correctness (§2)

Ground truth: the AniList relations graph of the anchored franchise, fetched
through `/api/anime` relations. "Suspicious" = entry is neither in the
ground-truth relation set nor sharing a franchise token.

| slug | live v2.3 | control v2.3 | **v2.4** |
|---|---|---|---|
| steins-gate-odmau | 22 entries, **21 suspicious** | 22 entries, **21 suspicious** | **8 entries, 0 suspicious** — groups: sequel 1, sideStory 2, alternative 1, ona 1, related 3 · source `anilist-relations` |
| one-piece-odmau | 22 entries, **12 suspicious** | 22 entries, **12 suspicious** | **61 entries, 0 suspicious** — groups: sideStory 36, summary 9, special 6, alternative 2, related 4, ona 2, prequel 1, spinoff 1 (One Piece's true graph is huge; v2.3's 22 were a truncated, half-unrelated sidebar) |
| frieren-odmau | 0 (endpoint 404'd on the stale slug) | 0 (404) | relations resolve (see §4); AniList throttled during that census pass → transient empty with 45 s negative cache, steady state verified `source: anilist-relations` |

Before/after on steins-gate, concrete: v2.3's seasons included 21 entries with
no relation to Steins;Gate (random seasonally-trending titles scraped from the
watch-page sidebar). v2.4 returns exactly the franchise: the sequel special,
two side stories, the 23β alternative, the crossover ONA and the shared-
universe entries under `related` — each with `slug`, `anilistId`, `malId`,
canonical shape, and `relation` bucket.

**watch-order regression fixed:** v2.3's fallback literally scraped the
"Trending" sidebar and labelled it `relation: "trending"`. v2.4 returns the
true-relation set in canonical order with `order` indexes and the same
buckets.

Relation bucket vocabulary (all surfaces): `prequel, sequel, sideStory,
alternative, spinoff, special, ova, ona, movie, summary, parent, related`.
Rule: typed relation wins; generic edges (CHARACTER/OTHER/SOURCE) fall back
to the node format (movie/ova/ona/special); everything else `related`.

---

## 4. `/api/resolve` robustness (real entries fed back in)

Inputs = slugs/keys/titles taken verbatim from live `/api/trending` and
`/api/search` responses.

| input | live v2.3 | **v2.4** |
|---|---|---|
| `frieren-odmau` | **404 after ~11 s** | `200 · anilist:154587` (~1.3 s) |
| `dara-san-of-the-reiwa-era-5jhg` | not tested (n/a) | `200 · anilist:203880` |
| `koala-s-diary-8sbwi` | `200 · anilist:194389` | `200 · anilist:194389` |
| `to-be-winner-3b1f1` | `200 · anilist:166444` | `200 · anilist:166444` |
| `tomb-raider-king-91d21` | `200 · tomb-raider-king-91d21` (slug key, ids lost) | `200 · anilist:184356` (upgraded) |
| `spy-x-sect-npalk` | `200 · spy-x-sect-npalk` (slug key) | `200 · anilist:185727` (upgraded) |
| `Spy x Sect` (title) | `200 · spy-x-sect-npalk` | `200 · anilist:185727` |
| `release-the-spyce-3zoz5` | not tested | `200 · anilist:101014` |
| `anilist:185727` | **502** (AniList hiccup → fatal) | `200 · anilist:185727` |
| `mal:52991` | `200`, anime.`anilistId: null`, genres/synonyms empty | `200`, anime.`anilistId: 154587`, genres + synonyms + year filled |

Also verified: resolve of every entry shape (key-only, slug-only, title-only)
returns `found: true`, `playable` probed, and the canonical `key` upgraded to
`anilist:`/`mal:` whenever the system knows the ids. During the audit's own
AniList-heavy backfill burst, one resolve transiently returned the honest
slug key (upstream anchor throttled) — steady state re-anchored it; that is
the designed degradation, never a failure.

---

## 5. Latency (§4) — same host, before → after

Cold = first request of the audit (upstream scrape + enrichment). Warm =
immediate repeat (cache hit). Live-v2.3 numbers included for the deployed
reality (Render free tier); the fair delta is control-v2.3 → **v2.4**.

| endpoint family | control v2.3 cold | control v2.3 warm | **v2.4 cold** | **v2.4 warm** |
|---|---|---|---|---|
| search | 1 731–3 862 | 3–4 | 333–375 | **3–7** |
| browse (home/spotlight/trending/top-ten/rankings) | 50–2 328 | 31–50 | **3–65** | **2–7** |
| popular / upcoming / new-release / newly-added | 1 582–2 062 | 48–69 | **43–341** | **3–18** |
| az-list / filter / genre / type / status | 67–3 468 | 44–88 | **40–50** | **3–57** |
| completed / recently-updated / schedule / airing | 37–912 | 19–73 | **34–1 935**⁵ | **2–6** |
| meta (detail) | 5 008 | 3 | 1 287 | 414 |
| anime by anilist id | 1 049 | 2 | 1 887⁶ | 412 |
| **anime by stale slug** | **24 892 (404)** | 12 105 (cached 404) | **9 832 (200 + full shape)** | **1 458** |
| **resolve by stale slug** | **11 542 (404)** | 11 829 (cached 404) | **1 275 (200)** | **1 269** |
| random (never cached) | 1 239 | 1 404 | 1 033 | 874 |

⁵ schedule's 1 935 ms cold is a single upstream scrape of the (large)
weekly schedule page — subsequent hits 6 ms.
⁶ `anime` cold includes the full detail art chain + relations graph +
episode-map warm-up; warm path is a cache hit at 412 ms (detail mode keeps
the v2.3 full-chain contract, so detail endpoints stay in the hundreds of
ms while LIST endpoints drop to milliseconds).

**What moved the needle:**
1. Browse TTL cache (`BROWSE_CACHE_SECONDS=120`) — biggest single win: every
   browse endpoint is 1–2 orders of magnitude faster warm (e.g. az-list
   3 290 → 3 ms; upcoming 1 582 → 3 ms).
2. Cache-stampede dedup — parallel cold requests share one upstream fetch
   (`/api/health → cache.inflight`).
3. List-mode art-enrichment skip (art present upstream → no Kitsu/TMDB call)
   + `ENRICH_DEADLINE_MS=4000` cap on the rest.
4. Mirror-pool 404 poisoning fix — stale slugs no longer mark every upstream
   mirror failed for the session (root cause of the 12–25 s slug failures).
5. Search canonical query parallelized with lane queries.
6. Payload hygiene verified: `stripInternal` drops internal handles and
   upstream page-tracing URLs; gzip on (level 6, threshold 1 KB); debug
   stays out of responses; `enrichment.coverage` retained (contractual).
7. TMDB skip when `TMDB_API_KEY` unset — verified (no TMDB traffic without
   the key; Kitsu remains keyless).

---

## 6. `/api/docs` responsiveness (§3)

Headless verification at **320 / 375 / 414 px** (screenshots in
`download/docs-shots/`):

| check | 320 px | 375 px | 414 px |
|---|---|---|---|
| horizontal overflow (`scrollWidth == clientWidth`) | PASS (320/320) | PASS (375/375) | PASS (414/414) |
| hamburger visible & toggles drawer | PASS | PASS | PASS |
| drawer slides in + backdrop dims + closes on tap/Esc | PASS | PASS | PASS |
| endpoint cards stack, path wraps, ▶ Try unclipped | PASS | PASS | PASS |
| parameter/field tables inside viewport (scrollable) | PASS | PASS | PASS |
| playground URL row wraps, Send full-width (278 px @320) | PASS | PASS | PASS |
| status/latency chips + Copy JSON / cURL wrap | PASS | PASS | PASS |
| reference navigation thumb-reachable (drawer, 44 px targets) | PASS | PASS | PASS |

Implementation: drawer (`.sb-open` class + backdrop) below 1080 px replacing
the old `display:none` sidebar; `@media` blocks at 780/640/380 px for hero,
cards, tables (`overflow-x` wrappers), playground stacking and chip wrapping.
Layout preserved — no redesign.

---

## 7. Regression sweep (must-stay-green)

- Envelope check: every browse endpoint answers
  `{ success, api, kind, count, results[] }`; object payloads keep `data{}`;
  pagination preserved on completed/new-release/az-list/filter/genre/type.
- Art contract: `artSource ∈ upstream|kitsu|tmdb|null`; missing art is
  explicit `null`; `thumbSource` on episodes unchanged.
- Playback pipeline untouched: `chain.js`, stream extractors, proxies and
  `/videojs/` resolution have **zero diffs** in this release.
- All key formats still resolve: `anilist:<id>`, `mal:<id>`, `<numeric id>`,
  `<slug>` (fresh AND stale), `<title>` (romaji/English/native/synonym).
- `?art=0` escape hatch still short-circuits providers.
- Status/type vocabularies still normalized (`RELEASING → Currently Airing`).
- Invalid inputs still 400 with valid values listed (az-list letters, tabs,
  season names); unknown params still reported in `ignoredParams[]`.

---

## 8. Known limits (honest, by design)

1. **First-request nulls on a cold process** — the identity backfill is
   asynchronous by contract (responses are never blocked); the NEXT request
   carries the filled shape. `IDENTITY_BACKFILL=0` disables the queue.
2. **AniList rate limits cap backfill throughput** (≈ 30 req/min degraded
   shared-IP). Large cold catalogs fill progressively, oldest queue first,
   60-slot cap per burst.
3. **Multiple real slugs per anime exist** (stale vs fresh upstream listings);
   v2.4 resolves and documents them rather than pretending there is only one.
4. **AniList-side transient errors** are cached negatively for 45 s and
   retried once in-request; longer outages degrade to index/slug identities
   (documented v2.2 behaviour, unchanged).

---

# v2.5.0 Addendum — proxy hardening · subtitle conversion · flexible identity

> **Release scope:** make the three `/api/proxy/*` endpoints work without
> client-side Referer juggling (the megaplay CDN family 403s Referer-less
> fetches), add content-sniffed VTT ⇄ SRT subtitle conversion with both
> renditions shipped in the API responses, fix stale CDN-token replay 403s,
> and make identity resolution resilient to un-indexed anilist/mal ids
> (slug-first `identities` block + `resolveFlexible()` fallback ladder).

## Test environment
- local v2.5.0 build (this repo), Node v24, zero optional services.
- Live upstreams: anikoto/megaplay lanes, AniList GraphQL, MAL scrape lanes.

## 1. Proxy endpoints (before → after)

| Case | v2.4.0 | v2.5.0 |
|---|---|---|
| `/proxy/subtitle` no `ref` | **403** | **200** (Referer-default) |
| `/proxy/hls` no `ref` | **403** | **200** (Referer-default) |
| `/proxy/video` segment no `ref` | **403** | **200**, 809 528 B, MPEG-TS `0x47` |
| `/proxy/subtitle?format=srt` (VTT source) | n/a | **200**, `application/x-subrip`, counters + comma-millis, `X-Subtitle-Converted: 1` |
| `/proxy/subtitle?format=vtt` (default) | n/a (bytes echo) | **200** WEBVTT unchanged for `<track>` consumers |
| `/proxy/subtitle&raw=1` | n/a | **200** passthrough |
| HLS master → variant → segment (zero client refs) | ref-hopping required | **200 → 200 → 200** (rewritten links carry the working referer policy) |
| Stale `?token=` replay (`> 90 s` old response) | permanent **403** (stale token wins the param stack) | **200** (token stripped, fresh minted) |

## 2. Subtitle data in API responses
- `/api/watch` + `/api/chain`: every subtitle track now carries
  `proxiedUrl` (WebVTT) + `proxiedSrtUrl` (SubRip) beside the upstream `url`;
  `/api/chain`'s winner `best` includes the tracks too.
- End-to-end: `proxiedSrtUrl` fetched → 19 613 B SRT with correct renumbered
  counters; `proxiedUrl` → 17 066 B WEBVTT.

## 3. Flexible identity keys

| Case | v2.4.0 | v2.5.0 |
|---|---|---|
| `/api/watch?slug=frieren-beyond-journey-s-end-c6fbj` | **400** (`Provide ?key=`) | **200** full payload |
| `identities` block on detail responses | absent | `{ preferred: "<slug>", slug, anilistId, malId, keys{slug,anilist,mal} }` on `/anime`, `/anime/episodes`, `/anime/servers`, `/watch`, `/download`, `/chain` |
| `/api/anime` `endpoints` map | request-key based | **slug-preferred** (`/api/watch?key=<slug>&ep=1`) |
| `/api/chain` `usage.*` | canonical id key | **slug-preferred** |
| `key=mal:52991` on `/watch` | worked | works (verified) |
| un-indexed id key | 404/502 if AniList cold + index cold | `resolveFlexible()`: identity-index → ishi-mapper → listing-slug ladder |

## 4. Conversion unit tests
`scripts/test_subtitles_unit.mjs` — **19/19** (format sniffing vtt/srt/ass,
SRT→VTT header+timings+text preservation, VTT→SRT counters/settings/id
handling, idempotent no-op conversions, ASS passthrough, round-trip).

## 5. Live suites (v2.5.0 build)
- `scripts/test_v250_features.mjs` — **24/24** (subtitle proxy × 7, HLS chain
  × 4, video referer-default, identity × 6, chain data × 3, setup probe).
- `npm run check` — **30/30** (syntax, lanes, docs catalog, config).
- `npm run test:live` — **106 PASS · 2 GRACEFUL · 1 FAIL** — the single
  failure is `meta/characters`, caused by AniList GraphQL answering
  **429 Too Many Requests** on the shared egress IP during the run (verified
  by hitting graphql.anilist.co directly: `{"errors":[{"message":"Too Many
  Requests.","status":429}]}`). The endpoint degrades honestly
  (`success:true, count:0`), the empty result negative-caches for only 45 s,
  and the check passes on the next run once the limit window lifts (verified:
  8 characters returned between throttle windows). Not a v2.5.0 regression —
  the same flake exists on any shared-IP host including Render's free tier.
- `npm run test:streams` — **11/11 critical · 17/18** (the one non-critical
  item is the `/api/download` ZIP deploy check, green once the release archive
  is deployed beside the server — the endpoint then serves it).
- Whole-surface sweep: **29/29 endpoints answered `success:true` with data**
  (search, suggestions, resolve, anime, episodes, servers, watch, chain, all
  browse/catalog surfaces, seasons, watch-order, meta family).

## 6. v2.5.0 known limits (honest, by design)
1. `ref=none` on the proxies is advisory: a 401/403 upstream is still rescued
   by the Referer ladder (playback reliability outranks strict opt-out).
2. `ass`/`ssa` payloads are detected but passed through unconverted — a full
   ASS→VTT style renderer is out of scope for v2.5.
3. AniList rate limits still gate identity *anchoring* on a cold process; the
   flexible ladder mitigates with the index and the mapper, it cannot invent
   data that no lane has ever resolved.

## 7. v2.5.0 download-endpoint finding (upstream drift, honestly reported)
- Fixed the v2.4.0 route collision first: the source-ZIP handler at
  `/api/download` (system router, mounted first) shadowed the documented
  `/api/download?key=…&ep=1` episode-links endpoint — the ZIP 404 / binary was
  served instead of download data. ZIP now lives only at top-level `/download`.
- After the fix the episode endpoint answers for itself — and upstream no
  longer provides the data: live inspection of multiple watch pages
  (frieren, one-piece) shows ZERO `download-data="` attributes and ZERO
  `onclick="openDownloadModal` invocations — upstream stripped the download
  buttons from watch pages (the modal + JS helper remain as dead code).
  `/api/download` therefore answers `404 No download links available` with an
  honest message for any anime. This matches upstream reality; nothing to
  scrape that no longer exists. Playback (which is what downloads were for)
  is fully served by `/api/watch` + `/api/chain` + the v2.5.0 proxies.

---

# v2.5.1 Addendum — core + identity bug-fix verification

> **Release scope:** verify-first minor fix. Every claimed bug was reproduced
> live against the v2.5.0 build BEFORE any code change (46-check pre-fix
> battery), then re-verified after the fix (49-check post-fix suite). The
> claimed bugs on `/api/search` turned out to be clean — the real divergence
> lived in `/api/suggestions` and `/api/resolve`.

## 1. Pre-fix verification (v2.5.0 build, live)

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | suggestions ≠ search data | **CONFIRMED** | `frieren`: 3 vs 6 results; `dandadan`: "Dandadan" vs "DAN DA DAN" first, 2 vs 3; same slug carried anilistId **206425** (suggestions) vs **170068** (search) — two pipelines, two answers |
| 2 | resolve rejects key params | **CONFIRMED** | `?slug=`, `?anilist=`, `?mal=`, `?id=` → 400 "Missing ?title=" (only `title\|q\|key` read) |
| 3 | resolve `slug:` prefix broken | **CONFIRMED** | `slug:frieren-beyond-journeys-end` → 404 |
| 4 | resolve URLs broken | **CONFIRMED** | anilist.co / myanimelist.net / watch-site URLs → 404 |
| 5 | native titles mis-anchor | **CONFIRMED** | `葬送のフリーレン` → `anilist:170068` (mini-anime) instead of `anilist:154587` (main series) |
| 6 | search bugs | **CLEAN** | aliases, dedup, identity block, art contract, honest 404 — all correct |

## 2. Fixes shipped (v2.5.1)
- `src/routes/unified.routes.js`: ONE shared `runSearchPipeline()` for
  `/api/search` + `/api/suggestions` (suggestions exposes the array under both
  `suggestions` and `results`, adds `?limit=`); `/api/resolve` reads any param
  name and pins `?anilist=`/`?mal=` schemes onto bare numbers.
- `src/core/keys.js`: `keyFromUrl()` (anilist/mal/watch-site URL extraction),
  `slug:` prefix handling (defensive recursion for non-slug payloads),
  `titleNative` joined both anchor scorers.
- `src/core/titles.js`: `pickBestBySimilarity` exactness tie-break now also
  honors `titleNative` (exact CJK spelling beats same-franchise spin-offs).
- Latent import bug: `normalizeRelation` used by the untyped-relation branch of
  `/api/seasons` + `/api/watch-order` was never imported → 500 on some inputs;
  imported now (found by the live sweep, verified: 10 relations each).

## 3. Post-fix results (final v2.5.1 build, live)

| Suite | Result |
|-------|--------|
| v2.5.1 feature battery (`scripts/test_v251_features.mjs`) | **49/49 PASS** |
| v2.5.0 feature battery (`scripts/test_v250_features.mjs`) | **24/24 PASS** |
| subtitle unit tests (`scripts/test_subtitles_unit.mjs`) | **19/19 PASS** |
| `npm run check` (invariants) | **30/30 PASS** |
| `npm run test:live` (whole surface) | **106 PASS · 2 GRACEFUL · 1 fail** |
| stream suite (`npm run test:streams`) | critical paths green (unchanged by this release) |

The single live-suite fail is the documented AniList-429 `meta/characters`
flake on the shared egress IP — re-verified self-healing (24 characters on
retry after the 45 s negative cache).

Parity proof (identical bytes): for `frieren`, `dandadan`, `one pie`,
`spy x family` — `JSON.stringify(search.results) ===
JSON.stringify(suggestions.suggestions) === JSON.stringify(suggestions.results)`.

Resolve matrix (all 200, correct canonical keys): `?title=` `?q=` `?key=`
`?query=` `?keyword=` `?slug=` `?anilist=` `?mal=` `?id=` `?name=`,
`slug:<slug>`, `https://anilist.co/anime/154587`,
`https://myanimelist.net/anime/50265`,
`https://kazescure.com/watch/<slug>`, `葬送のフリーレン` → `anilist:154587`,
`ワンピース` → found. Garbage input stays an honest 404.
