#  APIKuoshi

**One anime REST API — search, browse, metadata and playback through a single, coherent surface.**

APIKuoshi fetches anime data live from public web sources, normalizes it into one stable JSON schema and serves it through one endpoint set. There is exactly one way to do each thing: search, browse, episodes, streams, metadata — and every response feels like it came from one system, because it did.

**v2.1 — the /videojs/ stream refresh**: upstream changed how streams are served (raw embeds now 410). APIKuoshi rebuilds playback around the current `/videojs/` player — auto-migration, AES source decryption, 90-second CDN tokens — and renames servers to friendly codenames (`Vidstream-2 → riyo`) while keeping the raw label in `originalName`. See [CHANGELOG.md](CHANGELOG.md).

**v2.2 — the unified identity release**: every catalog/meta endpoint serves ONE canonical anime shape (single normalization layer, `src/core/shape.js`), the `slug` survives every transformation, ANY name resolves (`anilist:<id>` | `mal:<id>` | `<id>` | `<slug>` | `<title>` — colons included), AniList is an anchor instead of a requirement (MAL-only / slug-only identities degrade gracefully instead of 502-ing), `/api/meta/recommendations` merges AniList **and** MAL without dropping entries that lack an AniList id, and every episode carries a consistent `thumbnail`. See [CHANGELOG.md](CHANGELOG.md).

**v2.3 — the browse/catalog + art-enrichment release**: the WHOLE browse/catalog surface (home, spotlight, trending, rankings, top-ten, popular, random, upcoming, schedules, az-list, filter, genre, type, status, seasons, watch-order) now emits the exact same canonical shape as the detail endpoints — plus a single art-enrichment chain (`src/core/enrich.js`): upstream → **Kitsu** (keyless) → **TMDB** (optional, keyed), filling `poster`, `cover`, `backdrop`, `logo` and episode `thumbnails` with strict fallbacks. Every entry reports `artSource`. Provider failures degrade to "no data" — they never break a response and never fabricate art. See [CHANGELOG.md](CHANGELOG.md).

**v2.4 — the completeness + true-relations + performance release**: a shared identity index (`src/core/identity.js`) shares everything ANY endpoint resolves with EVERY other endpoint — the same anime now carries the same complete shape (ids, year, status, genres, synonyms, titles) on every surface, with a bounded background backfill for rows nothing has resolved yet (honest `null`s until then, never fabricated data). Stale upstream slugs resolve again (slug repair — `/api/anime?key=frieren-odmau` went from a 25 s 404 to a ~1.5 s 200). `/api/seasons` + `/api/watch-order` serve the AniList relations graph — true relations only, canonically bucketed (`prequel/sequel/sideStory/alternative/spinoff/special/ova/ona/movie/summary/parent/related`), franchise-validated fallback. `/api/docs` is fully responsive at 320–414 px (drawer sidebar, stacked cards, scrollable tables). And a performance pass (browse TTL cache, cache-stampede dedup, list art-enrichment skip + deadline) takes warm browse endpoints from seconds to single-digit milliseconds. See [CHANGELOG.md](CHANGELOG.md) and [TEST_REPORT.md](TEST_REPORT.md).

**v2.5 — the proxy-hardening + subtitle-conversion + flexible-identity release**: the three `/api/proxy/*` endpoints now send the player Referer by default with a 401/403 retry ladder (the megaplay CDN family — anipixcdn/nexabloom/qeltrix/zhaevor/quavex — 403s every Referer-less fetch), so subtitle/HLS/video playback works with zero client-side ref juggling. `/api/proxy/subtitle` sniffs the source format from the bytes and converts on the fly — `?format=srt` serves SubRip, `?format=vtt` (default) serves WebVTT, `&raw=1` passes through — and every subtitle track in `/api/watch` + `/api/chain` responses carries ready-made `proxiedUrl` (VTT) + `proxiedSrtUrl` (SRT). Stale 90 s CDN tokens are re-minted instead of stacked, so replayed older responses play again. And identity is now flexible everywhere: every detail response carries an `identities` block (`preferred` slug-first key + `anilist:`/`mal:` alternates), `?slug=` is accepted anywhere `?key=` is, and `resolveFlexible()` silently climbs identity-index → ishi-mapper → listing-slug when an id key is not indexed upstream — no more 404/502 for un-indexed anime. See [CHANGELOG.md](CHANGELOG.md).

**v2.5.1 — the core+identity bug-fix release**: `/api/suggestions` now runs the SAME pipeline as `/api/search` and returns the identical results array (same items, same canonical `anilistId`/`malId`/`key`/`slug` — merged in, never null — same order) under both `suggestions` and `results`, so typeahead UIs feed other endpoints without a second lookup (`?limit=` trims for typeahead). `/api/resolve` accepts any param name (`title`/`q`/`key`/`slug`/`anilist`/`mal`/`id`/`url`/…) and any key format — `slug:`-prefixed keys, pasted anilist.co / myanimelist.net / watch-site URLs (the id or slug is extracted), and native-script titles (葬送のフリーレン now anchors to the main series, not a same-franchise mini-anime — `titleNative` joined the anchor scorer). Plus a latent `normalizeRelation` import bug that could 500 `/api/seasons` and `/api/watch-order` is fixed. See [CHANGELOG.md](CHANGELOG.md).

---

##  Highlights

- **One surface, one schema** — every list endpoint answers `{ success, api, kind, count, results[] }`; every anime is one canonical resource.
- **Completeness guarantees (v2.4)** — `anilistId`/`malId`/`year`/`status`/`type`/`episodes`/`genres`/`synonyms`/`title*` are shared across endpoints via the identity index: once ANY endpoint resolves an anime, EVERY endpoint serves the complete shape for it. `/api/resolve` succeeds for any entry any endpoint returns — slug-only, stale-slug, title-only, key-only.
- **Canonical identity** — every anime has one key (`anilist:<id>` | `mal:<id>` | `<id>` | `<slug>` | `<title>`). Any endpoint accepts any format; the listing `slug` rides along on every anime-shaped response as the human-facing address.
- **Automatic dedup** — the same anime listed under romaji, English or synonym spellings is merged into a single result (title signatures + Dice/Jaccard similarity, with season/type guards).
- **Automatic failover** — data is fetched through internal lanes in priority order; a slow or empty lane never becomes your error.
- **Art enrichment chain (v2.3)** — when upstream art is thin, Kitsu (keyless) and optionally TMDB fill poster/cover/backdrop/logo and per-episode thumbnails; `artSource` says which provider won (`upstream | kitsu | tmdb`). Bounded concurrency (8), 24 h provider caching, per-request `&art=0` opt-out, global `ART_ENRICHMENT=0` kill switch.
- **One status/type vocabulary (v2.3)** — `RELEASING` and `Currently Airing` can never diverge between endpoints; art fields are explicit (`null` when nothing could fill them, never missing).
- **`/api/chain` — the flagship** — one call runs the whole streaming pipeline as nested functions: `resolve → info → episodes → servers → streams → probe`, with every stream URL verified against the real CDN and a ready-to-play `best` stream in the answer.
- **/videojs/ stream pipeline (v2.1)** — raw embeds are auto-migrated to the working `/videojs/` player, the AES-encrypted sources blob is decrypted, and a fresh 90 s CDN token is attached — streams play instead of 410-ing.
- **Friendly server codenames (v2.1)** — `Vidstream-2 → riyo`, `Vidstream-1 → kaito (beta)`, `HD-1 → hana`, … with the raw label preserved in `originalName`. One editable map in `src/sources/kaze/helper/cdn.helper.js`.
- **CORS playback proxies built in** — `/api/proxy/hls`, `/api/proxy/video`, `/api/proxy/subtitle` restream media through your own origin (re-tokenizing token-gated CDNs on every hop, Referer-default with a 401/403 retry ladder) so browsers just play it. The subtitle proxy converts between WebVTT and SubRip on the fly (`?format=srt|vtt`, content-sniffed, `&raw=1` passthrough) and every subtitle track from `/api/watch`/`/api/chain` ships both renditions (`proxiedUrl` + `proxiedSrtUrl`).
- **Flexible identity keys (v2.5)** — every anime is addressable by slug, anilist id, mal id or title from ANY endpoint (`?key=` and `?slug=`); detail responses carry an `identities` block whose `preferred` key is slug-first (slugs always resolve upstream), and `resolveFlexible()` falls back identity-index → ishi-mapper → listing-slug when an id is not indexed — un-indexed titles stop 404-ing.
- **Zero required services** — no API keys, no paid subscriptions, no FlareSolverr needed. Optional upgrades exist (see Configuration).

---

##  Requirements

| | |
|---|---|
| Node.js | ** ≥ 18.17** |
| RAM | ~150 MB free |
| Network | outbound HTTPS (data is fetched live) |

---

##  Installation

```bash
# 1. unzip / clone into a folder
cd APIKuoshi

# 2. install dependencies
npm install

# 3. (optional) create your config
cp .env.example .env

# 4. start
npm start          # production
npm run dev        # watch mode
```

The API boots on **http://localhost:6969** (change with `PORT` in `.env`).

First thing to try:

```bash
curl http://localhost:6969/api/health
curl "http://localhost:6969/api/search?q=frieren"
curl "http://localhost:6969/api/chain?q=frieren&ep=1"
```

Open **http://localhost:6969/api/docs** in a browser for the interactive documentation + playground.

---

##  Documentation

APIKuoshi documents itself, generated from the same catalog that powers the code:

| URL | What you get |
|---|---|
| `GET /api/docs` | Interactive API reference + playground (browsers) |
| `GET /api/docs.json` | Machine-readable endpoint catalog |
| `GET /api/openapi.json` | OpenAPI 3.1 spec generated from the same catalog |
| `GET /` | Landing JSON with quick links |

The v2.1 docs are a professional API-reference layout: a fixed sidebar with grouped endpoint navigation and search, compact reference cards with parameter tables, per-endpoint "▶ Try" buttons, and a docked playground (Send → status/latency chips → syntax-highlighted JSON, Copy JSON / Copy as cURL, request history).

---

##  Endpoint map

### Core
| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=&page=` | Deduplicated search — one entry per anime |
| `GET /api/suggestions?keyword=` | Live typeahead |
| `GET /api/resolve?title=` | Any title → canonical key + playability check |

### Anime
| Endpoint | Purpose |
|---|---|
| `GET /api/anime?key=` | Full info + endpoint map for the anime |
| `GET /api/anime/episodes?key=` | One flat episode list |
| `GET /api/anime/servers?key=&ep=&type=` | Server list for an episode (`name` codename + `originalName` + `beta` flag) |

### Playback
| Endpoint | Purpose |
|---|---|
| `GET /api/watch?key=&ep=&type=` | Playable streams: direct `url`, `embedUrl`, `proxiedUrl`, `qualities`, `subtitles`, `skipIntro` |
| `GET /api/download?key=&ep=` | Download links |
| `GET /api/chain?q=\|key=\|slug=&ep=` | One call: whole pipeline + CDN probe + `best` stream |
| `GET /api/proxy/hls?url=` | HLS restreamer with URI rewriting + auto re-tokenization |
| `GET /api/proxy/video?url=` | Range-aware video/segment restreamer |
| `GET /api/proxy/subtitle?url=` | Subtitle restreamer |

### Browse
`/api/home` · `/api/spotlight` · `/api/trending` · `/api/trending-sidebar` · `/api/top-ten` · `/api/top-rankings?sort=` · `/api/popular` · `/api/random` · `/api/upcoming` · `/api/completed?page=` · `/api/new-release?page=` · `/api/newly-added?page=` · `/api/latest-updated?page=` · `/api/recently-updated?tab=` · `/api/schedule` · `/api/airing`

### Catalog
`/api/az-list/:letter` · `/api/filter?genre=&type=&status=&…` · `/api/genre/:genre` · `/api/type/:type` · `/api/status/:status` · `/api/seasons/:slug` · `/api/watch-order/:slug`

### Meta
`/api/meta?key=` · `/api/meta/characters?key=&limit=` · `/api/meta/recommendations?key=&limit=` · `/api/meta/season?season=&year=` · `/api/meta/mal?key=&episodes=1` · `/api/meta/external?key=` · `/api/meta/trending`

### System
`/api/health` · `/api/docs` · `/api/docs.json` · `/api/openapi.json`

---

##  Usage examples

**Search — always one entry per anime:**

```bash
curl "http://localhost:6969/api/search?q=frieren"
```

```json
{
  "success": true,
  "api": "APIKuoshi",
  "query": "frieren",
  "page": 1,
  "count": 6,
  "results": [
    {
      "key": "anilist:154587",
      "anilistId": 154587,
      "malId": 52991,
      "title": "Sousou no Frieren",
      "titleRomaji": "Sousou no Frieren",
      "titleEnglish": "Frieren: Beyond Journey's End",
      "poster": "https://…jpg",
      "year": 2023,
      "type": "TV",
      "episodes": 28,
      "status": "Finished Airing"
    }
  ]
}
```

**One call from nothing to a playable stream:**

```bash
curl "http://localhost:6969/api/chain?q=frieren&ep=1"
```

```json
{
  "success": true,
  "api": "APIKuoshi",
  "anime": { "key": "anilist:154587", "title": "Sousou no Frieren", "…": "…" },
  "episode": { "requested": 1, "number": 1 },
  "servers": [ { "name": "hana", "originalName": "HD-1", "type": "sub" }, "…" ],
  "streams": [
    {
      "provider": "hana",
      "originalName": "HD-1",
      "type": "sub",
      "url": "https://fetch.nexabloom.top/…/master.m3u8?token=…",
      "embedUrl": "https://megaplay.buzz/videojs/stream/s-2/…/sub",
      "proxiedUrl": "/api/proxy/hls?url=…",
      "kind": "direct",
      "isHls": true,
      "qualities": [ { "label": "1080p", "url": "…" } ],
      "subtitles": [ { "label": "English", "language": "eng", "url": "…", "format": "vtt", "default": true } ],
      "skipIntro": { "intro": { "start": 0, "end": 89 }, "outro": { "start": 1460, "end": 1549 } },
      "probe": { "playable": true, "httpStatus": 200, "latencyMs": 184, "detail": "HLS master playlist — 1 variant" }
    }
  ],
  "best": { "provider": "riyo", "originalName": "Vidstream-2", "proxiedUrl": "/api/proxy/hls?url=…", "…": "…" },
  "verdict": "playable",
  "steps": [ { "step": "resolve", "ok": true, "ms": 0, "detail": "anilist:154587 — Sousou no Frieren · via search" }, "…" ],
  "timing": { "totalMs": 3421, "stepsMs": { "resolve": 0, "info": 1, "episodes": 59, "servers": 47, "streams": 2408, "probe": 928 } },
  "usage": { "replay": "/api/chain?q=frieren&ep=1", "nextEpisode": "/api/chain?q=frieren&ep=2", "playerHint": "Play best.proxiedUrl directly in an HLS-capable <video> (hls.js) — CORS is already handled." }
}
```

### How streams are resolved (v2.1 /videojs/ pipeline)

Upstream episode links point at raw embed pages that answer **410** to direct playback. APIKuoshi auto-migrates every link to the working `/videojs/` player and walks the site's own pipeline:

```
megaplay.buzz/stream/s-{sv}/{realId}/{type}          ← raw AJAX link (410s)
  → megaplay.buzz/videojs/stream/…                    ← /videojs/ migration
  → player page → data-id                             ← file id
  → /videojs/stream/getSources?id=…                   ← tracks + intro/outro + enc
  → AES-256-CBC decrypt of enc                        ← { file: master.m3u8 }
  → + fresh 90 s HMAC ?token=                         ← token-gated CDNs
  → playable url · embedUrl · proxiedUrl · qualities · subtitles · skipIntro
```

### Server naming

| upstream label | codename (`name`) | note |
|---|---|---|
| `Vidstream-2` | `riyo` | |
| `Vidstream-1` | `kaito` | site's beta/pretest server → `beta: true` |
| `HD-1` / `HD-2` | `hana` / `sora` | |
| `VidCloud-1` / `VidCloud-2` | `akira` / `yuki` | |
| `VidPlay-1` / `VidPlay-2` | `miso` / `kenji` | |
| `StreamTape-1` / `StreamTape-2` | `arashi` / `taiki` | |

The raw label always rides along as `originalName`. To change any codename, edit `SERVER_CODENAMES` in `src/sources/kaze/helper/cdn.helper.js` — that's the single source of truth used by every endpoint.

**Play it in a browser:**

```html
<video src="http://localhost:6969/api/proxy/hls?url=<best.url>&ref=https%3A%2F%2Fmegaplay.buzz%2F" controls></video>
<!-- or take best.proxiedUrl directly — it already carries the right form -->
```

**Verdict meanings (`/api/chain`):**

| verdict | meaning |
|---|---|
| `playable` | at least one stream verified against the real CDN |
| `unverified` | streams resolved but probing skipped (`?probe=0`) |
| `embed-only` | only player pages found — play them in an `<iframe>`, not `<video>` |
| `no-playable-streams` | direct streams resolved but every probe failed |
| `no-streams` | no stream URLs could be resolved |

---

##  Art enrichment (v2.3)

Every anime-shaped response runs through one enrichment chain (`src/core/enrich.js`) after normalization:

| Order | Provider | Needs a key? | Provides |
|---|---|---|---|
| 1. **Upstream** | the scraped source | no | `poster` (wins whenever present) |
| 2. **Kitsu** | kitsu.app JSON:API | **no — keyless** | `poster`, `cover`, episode thumbnails (mirrors MAL's per-season split; `malId → /mappings` first, title search fallback) |
| 3. **TMDB** | themoviedb.org | **yes — `TMDB_API_KEY`** | `poster` (season-aware), `backdrop`, `logo`, episode stills (with `extractSeasonHint()` so "… Season 3"/"… II" map to the right season, and an air-date sanity check against wrong episode matches) |

Hard guarantees:

- **A provider failure never breaks a response.** Every call is caught and time-capped (12 s); a dead provider just means "no data" and the chain continues.
- **Nothing is fabricated.** If no source has art, `poster` is `null` *explicitly* (never missing, never a fake URL) and `artSource` is `null`.
- **`artSource`** on every entry tells you which provider supplied the winning poster: `upstream` \| `kitsu` \| `tmdb` \| `null`. Episode records carry `thumbSource` (`poster` = series-poster fallback).
- **Lists stay fast**: enrichment runs with bounded concurrency (`ENRICH_CONCURRENCY`, default 8), providers cache internally for 24 h, and in-flight requests for the same anime share one upstream fetch.
- **Opt out any time**: per request with `&art=0`, or globally with `ART_ENRICHMENT=0`.

TMDB is **optional**: with no `TMDB_API_KEY` set, TMDB is skipped silently (zero log noise, zero latency) and the Kitsu path still fills poster/cover. Kitsu works with no configuration at all.

**v2.4 list-mode refinement:** list items whose art is already present from upstream skip the providers entirely (no Kitsu cover hunt for a row that has a poster — `cover` stays best-effort and explicit-`null` where nothing ran), and list enrichment respects a wall-clock cap (`ENRICH_DEADLINE_MS`, default 4 s) so a slow provider can never hold a response hostage. Detail endpoints (`/api/anime`, `/api/meta`, `/api/random`) keep the full chain.

---

##  Data completeness guarantees (v2.4)

Every anime-shaped entry is built by the canonical builder and then passed
through the **shared identity index** (`src/core/identity.js`) — one
cross-endpoint record of everything this process has ever resolved, keyed by
every address it is known under (AniList id, MAL id, every listing slug it
ever appeared under — stale ones included — and every normalized title).

- **The same anime carries the same complete shape on every endpoint.** Once
  `/api/anime`, `/api/search`, `/api/resolve`, `/api/meta/*` or the relations
  graph has resolved ids/metadata for a title, every browse/catalog row for
  that same title inherits them (`anilistId`, `malId`, `year`, `status`,
  `type`, `episodes`, `genres`, `synonyms`, `title*`) — and its `key` upgrades
  to the canonical `anilist:`/`mal:` form.
- **`/api/resolve` accepts any entry any endpoint returns.** Slug-only,
  stale-slug (`frieren-odmau` → `anilist:154587`), title-only, `mal:`-only —
  all resolve. Stale upstream slugs (whose watch pages are gone) are repaired
  by progressively shortened searches + multi-candidate anchoring with a
  season-decoration guard.
- **Nothing is invented.** A field is filled only when a real resolution
  (AniList, MAL, the catalog itself) produced it. Unknowns stay explicit
  `null`s. Rows nothing has resolved yet are anchored in the background
  (bounded queue, `IDENTITY_BACKFILL=0` to disable) so the next request is
  complete — responses are never delayed by the backfill.
- **Arrays are always arrays, strings are never missing, art is explicit
  `null`** — the v2.3 null policy is unchanged and enforced everywhere.

---

##  Seasons & watch-order contract (v2.4)

`/api/seasons/:slug` and `/api/watch-order/:slug` serve **true relations
only**:

1. **Source of truth — the AniList relations graph.** Typed edges
   (PREQUEL/SEQUEL/SIDE_STORY/SPIN_OFF/…) are the upstream's own statement
   about the pair, so cross-franchise false positives are impossible by
   construction. Each entry follows the canonical list-item shape with its
   `slug` preserved and `anilistId`/`malId` filled.
2. **Canonical buckets** — `prequel, sequel, sideStory, alternative, spinoff,
   special, ova, ona, movie, summary, parent` (+ `related` for generic
   CHARACTER/OTHER/SOURCE edges, bucketed by the node's format when it has
   one). A typed relation always wins over a format guess.
3. **Franchise-validated fallback** — when no AniList identity exists, the
   upstream watch-page sidebar is used, but strictly filtered to entries
   sharing a title/slug root with the requested franchise, relation-labelled
   from the page itself. Unrelated entries are dropped, never returned.
4. **Watch order** — the same relation set in canonical sequence
   (`prequel → parent → sequel → sideStory → spinoff → movie → ova → ona →
   special → summary → alternative → related`) with an `order` index on every
   entry. The v2.3 behaviour of returning the "Trending" sidebar is gone.
5. **Transparency** — both responses carry `source`
   (`anilist-relations | kaze-sidebar`), `groups` (bucket → entries) and keep
   the v2.3 envelope (`kind`, `totalSeasons`/`totalRelated`, `count`, `data{}`).

```bash
curl "http://localhost:6969/api/seasons/steins-gate-odmau"   # 8 true relations, 0 strangers
curl "http://localhost:6969/api/watch-order/steins-gate-odmau?art=0"
```

---

##  Performance notes (v2.4)

- **Browse TTL cache** — browse/catalog scrapes are cached for
  `BROWSE_CACHE_SECONDS` (default 120 s; canonical, param-order-independent
  keys; `/api/random` never cached). Warm browse endpoints answer in
  single-digit milliseconds.
- **Stampede dedup** — parallel cold requests for the same resource share one
  upstream fetch (`/api/health → cache.inflight` shows live dedups).
- **List art-enrichment skip + `ENRICH_DEADLINE_MS`** — see Art enrichment
  above.
- **Identity-index lookups are synchronous Map reads** — the completeness
  pass adds no upstream latency to any request.
- **404s no longer poison the upstream mirror pool** — one stale listing slug
  used to mark every mirror failed and slow unrelated endpoints for a whole
  session.
- `gzip` (level 6) on; internal handles and upstream page-tracing URLs are
  stripped from payloads; TMDB is skipped entirely when unkeyed.
- Full before/after latency and completeness tables:
  [TEST_REPORT.md](TEST_REPORT.md).

---

##  Key formats

Every anime-shaped endpoint accepts the same `?key=`:

| Format | Example | Behaviour |
|---|---|---|
| `anilist:<id>` | `anilist:154587` | strongest, canonical |
| `mal:<id>` | `mal:52991` | mapped internally to AniList |
| `<number>` | `154587` | treated as an AniList id |
| plain title | `frieren` | resolved via search |

---

##  Configuration

Copy `.env.example` → `.env`. **Everything is optional** — the API boots with an empty config.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `6969` | HTTP port |
| `ALLOWED_ORIGINS` | `*` | CORS origins, comma-separated |
| `RATE_LIMIT_MAX` | `240` | Requests per window per IP (0 disables) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `CACHE_SECONDS` | `180` | Response cache TTL (0 disables) |
| `SOURCE_TIMEOUT_MS` | `20000` | Internal fetch timeout per phase |
| `DEDUP_THRESHOLD` | `78` | Title-match strictness 50–99 |
| `SOURCE_PRIORITY` | `kaze,ishi` | Advanced: internal lane order |
| `SCRAPER_API_KEY` | — | **Optional** paid scraperapi.com key |
| `FLARESOLVERR_URL` | — | **Optional** self-hosted FlareSolverr URL |
| `TMDB_API_KEY` | — | **Optional** TMDB v3 API key (free at [themoviedb.org](https://www.themoviedb.org/settings/api)) — enables backdrop/logo art, season-aware posters and episode stills. **The API works fully without it** — Kitsu (keyless) still fills poster/cover. |
| `ART_ENRICHMENT` | `1` | Set `0` to disable the art-enrichment chain globally (per-request alternative: `&art=0`) |
| `ENRICH_CONCURRENCY` | `8` | Bounded parallelism (1–16) for list enrichment |
| `MIRROR_DOMAINS` | auto | Optional extra catalogue mirrors |
| `STREAM_PROXY_DOMAINS` / `STREAM_PROXY_REFERER` | auto | Optional playback extraction tuning |
| `MEGAPLAY_SOURCE_ENC_KEY` / `MEGAPLAY_SOURCE_ENC_IV` | auto | Optional override if the site rotates the sources-blob keys |
| `MEGAPLAY_CDN_TOKEN_SECRET` / `MEGAPLAY_CDN_TOKEN_TTL` | auto | Optional override for the stream CDN token gate |

---

##  Testing

```bash
npm run check           # fast self-verification (syntax, wiring, invariants)
npm run test:live       # live end-to-end suite against the running API
npm run test:streams    # v2.1 stream suite: naming, watch (all servers × sub/dub), proxies, chain
```

The live suite covers every endpoint family, full chains (search → episodes → servers → watch), the `/api/chain` verdicts in all input forms, and clean-error contracts. The v2.1 stream suite additionally verifies server codenames, the `/videojs/` resolution, direct/embed/proxied playback (playlist → variant → MPEG-TS segment), subtitle proxying and chain probing.

---

##  Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `502` on an endpoint | The upstream web data was temporarily unavailable — retry shortly; the failover layer already tried alternates for you |
| Stream `403`s when played directly | Token-gated CDNs need a fresh `?token=` + player referer — use the provided `url` (tokenized) or `proxiedUrl`, which re-tokenize automatically |
| Search feels slow the first time | First fetch is live + uncached; repeats are served from the TTL cache |
| Port already in use | Change `PORT` in `.env` |
| Behind a corporate proxy | Set outbound `HTTPS_PROXY` in your environment; the fetchers honor standard proxy variables where supported |
| Streams stopped working entirely | The upstream player may have rotated keys/URLs — check `MEGAPLAY_*` env overrides and the changelog |

---

##  Disclaimer

This project is provided **for educational and personal use only**, to demonstrate REST API design, data normalization and media pipeline engineering.

- APIKuoshi **hosts, stores and distributes no content**. It is a search and normalization layer over data that is already publicly accessible on the internet.
- Availability of any title depends entirely on third-party public sources; nothing is guaranteed.
- You are responsible for complying with the laws and the terms of service of any jurisdiction and service you use this software with.
- This software is **not affiliated with, endorsed by, or connected to** any third-party website or service it can query.
- Trademarks and media belong to their respective owners.

Use responsibly.
