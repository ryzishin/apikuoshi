# APIKuoshi — Install & Deploy Guide (v2.5.0)

## 1. Local install

Requirements: **Node.js ≥ 18.17** (no API keys, no paid services, no
FlareSolverr needed — optional upgrades below).

```bash
# from the zip (or a fresh clone)
unzip apikuoshi-v2.5.0.zip && cd apikuoshi-v2.5.0
npm install          # postinstall compiles nothing external; engines enforced
npm start            # node server.js — serves on PORT (default 6969)
```

Sanity checks:

```bash
curl http://localhost:6969/api/health
curl http://localhost:6969/api/search?q=frieren
curl "http://localhost:6969/api/anime?key=frieren-beyond-journey-s-end-c6fbj"   # slug key
curl "http://localhost:6969/api/meta/recommendations?key=mal:52991"             # MAL key
curl "http://localhost:6969/api/docs"                                            # interactive docs
```

Dev mode with auto-reload: `npm run dev` (node --watch).

## 2. Configuration (all optional)

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `6969` | HTTP port |
| `NODE_ENV` | `development` | `production` hides internal error details in responses |
| `SOURCE_PRIORITY` | `kaze,ishi` | internal lane order |
| `CACHE_SECONDS` | `180` | unified-layer response TTL (0 disables) |
| `BROWSE_CACHE_SECONDS` | `120` | v2.4.0: TTL for browse/catalog scrapes — warm browse answers go from seconds to milliseconds (0 disables) |
| `ENRICH_DEADLINE_MS` | `4000` | v2.4.0: wall-clock cap on list art enrichment; late fills ship on the next request (0 disables) |
| `IDENTITY_BACKFILL` | `on` | v2.4.0: `0` disables the background identity backfill queue (rows would keep null ids until another endpoint resolves them) |
| `DEDUP_THRESHOLD` | `78` | title-match strictness for merging duplicate listings (50–99) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `240` / `60000` | in-memory per-IP limit (`0` disables) |
| `ALLOWED_ORIGINS` | `*` | comma-separated CORS origins |
| `MIRROR_DOMAINS` | built-in list | comma-separated upstream mirror domains, priority order |
| `MAL_SCRAPE_DELAY_MS` | `700` | politeness delay between MAL scrapes |
| `SCRAPER_API_KEY` | off | optional paid scraper for upstream fetches |
| `FLARESOLVERR_URL` | off | optional self-hosted FlareSolverr |
| `TMDB_API_KEY` | off | **optional** TMDB v3 API key — see §2.1 below. **Works without it.** |
| `ART_ENRICHMENT` | `1` | `0` disables the art-enrichment chain globally |
| `ENRICH_CONCURRENCY` | `8` | parallelism of list enrichment (1–16) |
| `STREAM_PROXY_REFERER` | `https://megaplay.buzz/` | referer some stream CDNs expect (playback) |

### 2.1 TMDB_API_KEY setup (optional)

The art-enrichment chain fills `poster`/`cover`/episode thumbnails via
**Kitsu (keyless — always on, zero setup)**. TMDB adds `backdrop`, `logo`,
season-aware posters and episode stills **on top**:

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Settings → API → **Create** → choose *Developer*, accept the terms, copy
   the **API Key (v3)**.
3. Put it in `.env`: `TMDB_API_KEY=your_v3_key_here` (or set it in your
   host's env vars).
4. Restart. Verify via `/api/health` → `enrichment.tmdb: "enabled"`.

**The API works fully without it**: with no key, TMDB is skipped silently
(zero log noise, zero latency) and Kitsu still fills poster/cover. With a
*Bogus* key, TMDB calls fail harmlessly — every provider error is caught and
treated as "no data", so responses stay 200 and clean. Per-request opt-out:
append `&art=0` to any browse/catalog endpoint.

## 3. Deploying to Render (matches the live deployment)

1. Push this repo to GitHub (or upload the zip contents).
2. Render → **New Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/api/health`
4. Env: set `NODE_ENV=production`. Everything else is optional.
5. Deploy. Render's free instances share egress IPs — the v2.2 identity
   layer is built for that (45 s failure caching instead of 24 h, graceful
   MAL/slug degradation), so transient upstream blocks degrade instead of
   failing the endpoint.

## 4. Deploying anywhere else

Any host that runs Node serves APIKuoshi: a systemd unit (`ExecStart=node
server.js` behind nginx/Caddy), Docker (`node:20-alpine`, `npm ci && npm
start`, expose `PORT`), Fly.io, Railway, or a VPS. There is no database and
no build step — the process is stateless apart from the in-memory caches.

## 5. Version notes

- v2.3.0 extends the canonical shape to the whole browse/catalog surface and
  adds the art-enrichment chain (`src/core/enrich.js` new; `src/core/kitsu.js`
  + `src/core/tmdb.js` provider modules; `src/core/shape.js`,
  `src/core/fallback.js`, `src/core/chain.js`, `src/routes/unified.routes.js`,
  `src/routes/system.routes.js`, `src/docs/catalog.js`, one upstream selector
  fix in `upcomingAnime.extractor.js`). Playback internals are untouched —
  `/api/chain` only gained a failure-isolated `episode-art` step that fills
  the episode block's thumbnail (read-only for the stream pipeline).
- v2.2.0/v2.2.1 touched only the catalog/meta identity layer. See
  `CHANGELOG.md` for the full list and `TEST_REPORT.md` for the
  endpoint-by-endpoint verification.
