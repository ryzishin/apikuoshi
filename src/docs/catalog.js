/**
 * ============================================================
 *  APIKuoshi — src/docs/catalog.js                    v2.0.0
 * ============================================================
 *  Machine-readable catalog: every endpoint, every knob.
 *  SINGLE SOURCE OF TRUTH consumed by:
 *    - GET /api/docs         -> generated interactive HTML + playground
 *    - GET /api/docs.json    -> this object as plain JSON
 *    - GET /api/openapi.json -> OpenAPI 3.1 generated from it
 *
 *  Endpoint shape:
 *    { m: method, p: path, d: description,
 *      params: [{ n: name, d: what it does, ex: example value }],
 *      try: ready-to-run example path (playground "Try it"), tip }
 * ============================================================
 */
import config from "../config.js";

// ---------------------------------------------------------------------------
// How APIKuoshi works (public story)
// ---------------------------------------------------------------------------

export const PIPELINE = {
  summary:
    "APIKuoshi fetches anime data live from public web sources, normalizes it into one schema, enriches the art and serves it through one coherent REST surface.",
  steps: [
    {
      n: 1,
      title: "Request",
      text: "You call one endpoint with a simple input: a search term, an anime key (anilist:<id> | mal:<id> | <id> | <slug> | <title>) or a listing slug.",
    },
    {
      n: 2,
      title: "Resolve",
      text: "The resolver turns any input into a canonical identity — AniList id when reachable, otherwise the MAL id or the listing slug — so the same anime is always the same resource, no matter which title spelling you used.",
    },
    {
      n: 3,
      title: "Fetch",
      text: "Internal data lanes fetch the raw data in priority order. If a lane is slow or empty, the next one takes over automatically — you just get data.",
    },
    {
      n: 4,
      title: "Normalize",
      text: "Raw page data is mapped into one stable schema — the SAME shape on detail, meta, search and every browse/catalog endpoint: slug always present, one status/type vocabulary, art fields explicit (null when nothing could fill them, never missing). Every entry reports artSource: upstream | kitsu | tmdb.",
    },
    {
      n: 5,
      title: "Enrich",
      text: "When upstream art is thin, one enrichment chain fills the gaps: Kitsu first (keyless, poster/cover/episode thumbnails), then TMDB (optional TMDB_API_KEY — backdrop, logo, season-aware posters, episode stills). Provider failures degrade to 'no data' — they never break a response, never fabricate art. Skip per request with &art=0.",
    },
    {
      n: 6,
      title: "Serve",
      text: "The response is cached briefly (fast repeats), rate-limited per IP and returned as plain JSON. Playback URLs are also offered through built-in CORS proxies.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Endpoints — the whole public surface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Streams (2026 pipeline) — field reference + server naming, consumed by the
// docs page. The /videojs/ pipeline: raw embed -> /videojs/ player ->
// getSources (AES-encrypted sources) -> tokenized m3u8/mp4.
// ---------------------------------------------------------------------------

export const STREAM_FIELDS = [
  { n: "provider", d: "friendly server codename (riyo, kaito, hana, …)" },
  { n: "originalName", d: "the raw upstream label (Vidstream-2, HD-1, …) — always preserved" },
  { n: "type", d: "sub | dub" },
  { n: "url", d: "direct, playable stream URL — tokenized for token-gated CDNs (90 s TTL)" },
  { n: "embedUrl", d: "the /videojs/ player page — iframe-able fallback" },
  { n: "proxiedUrl", d: "same-origin CORS proxy URL — paste into hls.js / <video> and it plays" },
  { n: "kind", d: "direct (m3u8/mp4) | embed (player page)" },
  { n: "isHls", d: "true when the stream is an HLS (m3u8) playlist" },
  { n: "qualities", d: "per-variant URLs parsed from the master playlist (1080p, 720p, …)" },
  { n: "subtitles", d: "subtitle tracks from getSources (label, language, url, format, default)" },
  { n: "skipIntro", d: "intro/outro skip ranges: { intro: {start,end}, outro: {start,end} }" },
  { n: "probe", d: "chain only — CDN verification: playable, httpStatus, latencyMs, refererRequired, detail" },
];

export const SERVER_NAMING = {
  "Vidstream-2": "riyo",
  "Vidstream-1": "kaito (beta)",
  "HD-1": "hana",
  "HD-2": "sora",
  "VidCloud-1": "akira",
  "VidCloud-2": "yuki",
  "VidPlay-1": "miso",
  "VidPlay-2": "kenji",
  "StreamTape-1": "arashi",
  "StreamTape-2": "taiki",
};

export const UNIFIED_ENDPOINTS = [
  // ---- CORE --------------------------------------------------------------
  {
    m: "GET",
    p: "/api/search",
    d: "Search the catalogue. Results are deduplicated automatically: the same anime listed under romaji, English or synonym spellings comes back as ONE entry anchored to its canonical id.",
    params: [
      { n: "q", d: "search term (romaji or English — both work)", ex: "frieren" },
      { n: "page", d: "result page, default 1", ex: "1" },
    ],
    try: "/api/search?q=frieren",
    tip: "Every result carries a canonical key (anilist:<id>) and its listing slug — feed either to /api/anime, /api/watch, /api/chain or /api/seasons.",
  },
  {
    m: "GET",
    p: "/api/suggestions",
    d: "Typeahead — v2.5.1: runs the SAME pipeline as /api/search, so the response carries the very same results array for the same term (same items, same canonical anilist/mal ids, same order) under both `suggestions` and `results`. Search-as-you-type UIs can feed any entry straight into /api/anime, /api/watch or /api/chain without a second lookup.",
    params: [
      { n: "keyword", d: "search term (aliases: q, query)", ex: "one pie" },
      { n: "page", d: "result page, default 1", ex: "1" },
      { n: "limit", d: "trim the tail for typeahead UIs (omit for the full /api/search result set)", ex: "10" },
    ],
    try: "/api/suggestions?keyword=one%20pie",
    tip: "`suggestions` and `results` hold the same array — read whichever matches your client. Keys (anilist/mal/slug) are always populated, never null.",
  },
  {
    m: "GET",
    p: "/api/resolve",
    d: "Turn ANY identity into the canonical key + confirm the anime is playable. The quickest way to bootstrap a watch flow. v2.5.1: the value may arrive under any param name (title/q/key/query/keyword/slug/anilist/mal/id/url/anime/name) and may be: anilist:<id> | mal:<id> | slug:<slug> | <numeric id> | <slug> | <title> (romaji / English / native / synonym) | a pasted URL (anilist.co, myanimelist.net, watch-site /watch/<slug> — the id or slug is extracted automatically).",
    params: [
      { n: "title", d: "any key format or title — see above for everything accepted (all other param names are aliases)", ex: "attack on titan" },
    ],
    try: "/api/resolve?title=attack%20on%20titan",
    tip: "Native-script titles work (葬送のフリーレン resolves to the main series, not a spin-off), and ?slug=/?anilist=/?mal= pin the scheme so bare numbers are read as the right id type.",
  },

  // ---- ANIME -------------------------------------------------------------
  {
    m: "GET",
    p: "/api/anime",
    d: "Full info for one anime + a ready-made endpoint map (episodes/servers/watch/download/meta/chain) for the same key.",
    params: [{ n: "key", d: "anilist:<id> | mal:<id> | <id> | <slug> | plain title (colons allowed)", ex: "anilist:154587" }],
    try: "/api/anime?key=anilist:154587",
  },
  {
    m: "GET",
    p: "/api/anime/episodes",
    d: "One flat episode list (number, title, filler flag when known). Availability is resolved automatically across internal channels.",
    params: [{ n: "key", d: "same key formats as /api/anime", ex: "frieren" }],
    try: "/api/anime/episodes?key=frieren",
  },
  {
    m: "GET",
    p: "/api/anime/servers",
    d: "Server list for one episode. Each entry carries a friendly codename (name), the raw upstream label (originalName), sub/dub type and the beta flag where the site marks one.",
    params: [
      { n: "key", d: "same key formats as /api/anime", ex: "anilist:154587" },
      { n: "ep", d: "episode number, default 1", ex: "1" },
      { n: "type", d: "sub | dub | all (default all)", ex: "sub" },
    ],
    try: "/api/anime/servers?key=frieren&ep=1",
    tip: "name is a friendly codename (riyo, kaito, hana, …); originalName keeps the upstream label (Vidstream-2, HD-1, …). beta: true marks the site's pretest server. Feed id into ?server= on /api/watch.",
  },

  // ---- PLAYBACK ----------------------------------------------------------
  {
    m: "GET",
    p: "/api/chain",
    d: "THE STREAMING CHAIN — one call, the whole journey, nested functions: resolve → info → episodes → servers → streams → probe. Give it a search term, an anime id, or a slug; it walks every hop itself, resolves each stream through the /videojs/ pipeline, tests each URL against the real CDN (fresh 90 s token, #EXTM3U validation, latency, referer requirement) and answers with a ready-to-play `best` stream. steps[] shows how long each hop took.",
    params: [
      { n: "q", d: "search term — resolved through the dedup search", ex: "dandadan" },
      { n: "key", d: "or an anime key: anilist:<id> | mal:<id> | <id> | <slug> | title", ex: "anilist:154587" },
      { n: "id", d: "alias of key (bare AniList id works)", ex: "154587" },
      { n: "slug", d: "or a direct listing slug", ex: "one-piece-odmau" },
      { n: "ep", d: "episode number, default 1", ex: "1" },
      { n: "type", d: "sub | dub | all", ex: "sub" },
      { n: "probe", d: "0 = skip CDN probing (faster, streams unverified)", ex: "" },
      { n: "all", d: "1 = collect every available stream, not just the first working one", ex: "" },
    ],
    try: "/api/chain?q=frieren&ep=1",
    tip: "verdict field: playable | unverified (probe=0) | no-playable-streams | embed-only (iframe-embeddable, no direct stream) | no-streams. best.proxiedUrl is CORS-ready — paste it straight into hls.js or a <video> tag. Streams carry originalName, qualities, subtitles and skipIntro.",
  },
  {
    m: "GET",
    p: "/api/watch",
    d: "Stream resolver: returns playable links for one episode. Every stream resolves through the /videojs/ pipeline (embed auto-migration, source decryption, 90 s CDN token) and includes direct url, embedUrl, proxiedUrl, qualities, subtitles and skipIntro.",
    params: [
      { n: "key", d: "same key formats as /api/anime", ex: "anilist:154587" },
      { n: "ep", d: "episode number, default 1", ex: "1" },
      { n: "type", d: "sub | dub | all", ex: "sub" },
      { n: "server", d: "preferred server (codename or original name — hint only)", ex: "riyo" },
    ],
    try: "/api/watch?key=frieren&ep=1",
    tip: "stream = the recommended pick; streams[] = everything found. proxiedUrl is CORS-ready for hls.js/<video>. Want the whole journey CDN-tested in one call? Use /api/chain.",
  },
  {
    m: "GET",
    p: "/api/download",
    d: "Download links for one episode.",
    params: [
      { n: "key", d: "same key formats as /api/anime", ex: "frieren" },
      { n: "ep", d: "episode number, default 1", ex: "1" },
    ],
    try: "/api/download?key=frieren&ep=1",
  },
  {
    m: "GET",
    p: "/api/proxy/hls",
    d: "HLS playlist restreamer: fetches an m3u8 and rewrites every segment/variant URI back through /api/proxy/* with CORS headers so browsers can play cross-origin streams. Token-gated CDNs are re-tokenized on every hop (fresh 90 s token), so playback never dies mid-video. v2.5.0: sends the player Referer by default (the stream CDNs 403 without it) and retries once through the Referer ladder on 401/403.",
    params: [
      { n: "url", d: "absolute m3u8 URL", ex: "https://example.com/master.m3u8" },
      { n: "ref", d: "optional Referer override; omitted = player Referer default, ref=none sends none", ex: "" },
    ],
    tip: "You normally never call this by hand — take stream.proxiedUrl from /api/watch or /api/chain.",
  },
  {
    m: "GET",
    p: "/api/proxy/video",
    d: "Range-aware video/segment restreamer with CORS. Pipe streams, .ts segments and mp4s through your own origin. Token-gated CDNs are re-tokenized automatically. v2.5.0: player-Referer default + 401/403 retry ladder.",
    params: [
      { n: "url", d: "absolute video/segment URL", ex: "https://example.com/seg-1.ts" },
      { n: "ref", d: "optional Referer override; omitted = player Referer default, ref=none sends none", ex: "" },
    ],
  },
  {
    m: "GET",
    p: "/api/proxy/subtitle",
    d: "Subtitle restreamer with CORS and format conversion (v2.5.0). Source format is sniffed from the payload (vtt/srt/ass); SRT sources are converted to WebVTT by default and VTT sources can be served as SubRip with &format=srt. VTT remains the default so <track> consumers are unaffected. The player Referer is sent by default (subtitle CDNs 403 without it). Response headers X-Subtitle-Source-Format / X-Subtitle-Format / X-Subtitle-Converted report what happened. Every subtitle track from /api/watch and /api/chain already carries ready-made proxiedUrl (VTT) + proxiedSrtUrl (SRT).",
    params: [
      { n: "url", d: "absolute subtitle URL", ex: "https://example.com/sub.vtt" },
      { n: "format", d: "output format: vtt (default) | srt", ex: "srt" },
      { n: "ref", d: "optional Referer override; omitted = player Referer default, ref=none sends none", ex: "" },
      { n: "raw", d: "raw=1 skips conversion and echoes the upstream payload", ex: "" },
    ],
  },

  // ---- BROWSE ------------------------------------------------------------
  {
    m: "GET",
    p: "/api/home",
    d: "Homepage payload: spotlight + latest sections in one call.",
    params: [],
    try: "/api/home",
  },
  {
    m: "GET",
    p: "/api/spotlight",
    d: "Homepage spotlight cards.",
    params: [],
    try: "/api/spotlight",
  },
  {
    m: "GET",
    p: "/api/trending",
    d: "What's trending right now.",
    params: [],
    try: "/api/trending",
  },
  {
    m: "GET",
    p: "/api/trending-sidebar",
    d: "Sidebar trending widget data.",
    params: [],
    try: "/api/trending-sidebar",
  },
  {
    m: "GET",
    p: "/api/top-ten",
    d: "Top 10 anime.",
    params: [],
    try: "/api/top-ten",
  },
  {
    m: "GET",
    p: "/api/top-rankings",
    d: "Ranked lists by period. Every entry carries `rank` on top of the canonical anime shape; unknown sort values come back in `invalidParams[]`.",
    params: [{ n: "sort", d: "top | week | month", ex: "week" }],
    try: "/api/top-rankings?sort=week",
  },
  {
    m: "GET",
    p: "/api/popular",
    d: "Most popular anime.",
    params: [],
    try: "/api/popular",
  },
  {
    m: "GET",
    p: "/api/random",
    d: "One random anime in the full canonical detail shape (poster/cover/backdrop/logo). Site-wide — filter params it cannot honour come back in `ignoredParams[]`.",
    params: [],
    try: "/api/random",
  },
  {
    m: "GET",
    p: "/api/upcoming",
    d: "Next season's upcoming anime.",
    params: [],
    try: "/api/upcoming",
  },
  {
    m: "GET",
    p: "/api/completed",
    d: "Completed anime, paginated.",
    params: [{ n: "page", d: "page number", ex: "1" }],
    try: "/api/completed",
  },
  {
    m: "GET",
    p: "/api/new-release",
    d: "New releases, paginated.",
    params: [{ n: "page", d: "page number", ex: "1" }],
    try: "/api/new-release",
  },
  {
    m: "GET",
    p: "/api/newly-added",
    d: "Titles newly added to the catalogue.",
    params: [{ n: "page", d: "page number", ex: "1" }],
    try: "/api/newly-added",
  },
  {
    m: "GET",
    p: "/api/latest-updated",
    d: "Episodes updated most recently.",
    params: [{ n: "page", d: "page number", ex: "1" }],
    try: "/api/latest-updated",
  },
  {
    m: "GET",
    p: "/api/recently-updated",
    d: "Recently-updated tabs (all/dub/sub/trending/random).",
    params: [{ n: "tab", d: "all | dub | sub | trending | random", ex: "all" }],
    try: "/api/recently-updated?tab=all",
  },
  {
    m: "GET",
    p: "/api/schedule",
    d: "Airing schedule (per weekday/date).",
    params: [],
    try: "/api/schedule",
  },
  {
    m: "GET",
    p: "/api/airing",
    d: "Currently airing anime.",
    params: [],
    try: "/api/airing",
  },

  // ---- CATALOG -----------------------------------------------------------
  {
    m: "GET",
    p: "/api/az-list/:letter",
    d: "Full catalogue by first letter (a–z or 0-9/other).",
    params: [
      { n: "letter", d: "path: first letter (a–z, 0-9, other)", ex: "a" },
      { n: "page", d: "page number", ex: "1" },
    ],
    try: "/api/az-list/a",
  },
  {
    m: "GET",
    p: "/api/filter",
    d: "Multi-facet filtered browse — combine keyword, genres, types, statuses, season, language, rating, episode ranges and sort.",
    params: [
      { n: "keyword", d: "free-text filter", ex: "" },
      { n: "genre", d: "comma-separated genres", ex: "action,adventure" },
      { n: "type", d: "tv | movie | ova | ona | special", ex: "tv" },
      { n: "status", d: "airing | completed | upcoming", ex: "airing" },
      { n: "season", d: "spring | summer | fall | winter", ex: "" },
      { n: "language", d: "sub | dub | chinese", ex: "sub" },
      { n: "sort", d: "sort order", ex: "default" },
      { n: "ep_min", d: "min episode count", ex: "" },
      { n: "ep_max", d: "max episode count", ex: "" },
      { n: "page", d: "page number", ex: "1" },
    ],
    try: "/api/filter?genre=action&status=airing&language=sub",
  },
  {
    m: "GET",
    p: "/api/genre/:genre",
    d: "Browse by genre slug (action, adventure, comedy, ...).",
    params: [
      { n: "genre", d: "path: genre slug", ex: "action" },
      { n: "page", d: "page number", ex: "1" },
    ],
    try: "/api/genre/action",
  },
  {
    m: "GET",
    p: "/api/type/:type",
    d: "Browse by type (tv, movie, ova, ona, special).",
    params: [
      { n: "type", d: "path: anime type", ex: "tv" },
      { n: "page", d: "page number", ex: "1" },
    ],
    try: "/api/type/tv",
  },
  {
    m: "GET",
    p: "/api/status/:status",
    d: "Browse by airing status: airing/ongoing, completed/finished, upcoming.",
    params: [
      { n: "status", d: "path: airing | completed | upcoming", ex: "airing" },
      { n: "page", d: "page number", ex: "1" },
    ],
    try: "/api/status/airing",
  },
  {
    m: "GET",
    p: "/api/seasons/:slug",
    d: "Every season and relation of the franchise (any key form: slug, anilist:<id>, mal:<id>, title). v2.5.2: walks the AniList relations graph transitively — call it on season 3 and you still get S1, S2, S2P2, S3 and every OVA/movie, not just season 3's immediate prequel. ?deep=0 keeps the v2.5.1 direct-only behaviour. The queried anime is exposed separately as `root` (relation='self').",
    params: [
      { n: "slug", d: "path: anime slug or key", ex: "steins-gate-0-cbge5" },
      { n: "deep", d: "0 = only direct AniList relations (v2.5.1 behaviour); 1 = walk the whole franchise (default)", ex: "1" },
    ],
    try: "/api/seasons/steins-gate-0-cbge5",
  },
  {
    m: "GET",
    p: "/api/watch-order/:slug",
    d: "The COMPLETE franchise watch order, sorted by release year (any key form: slug, anilist:<id>, mal:<id>, title). v2.5.2 — THE WATCH-ORDER FIX: instead of returning only AniList's DIRECT relations of the queried entry (which missed the parent show when called on a sequel — Steins;Gate 0 returned only its OVAs, not the original Steins;Gate; Mushoku S3 returned only S2P2), the endpoint now walks the relations graph transitively and returns every season, OVA, movie and side-story. The queried anime is included in `watchOrder[]` with relation='self' and `releaseOrder` (1-based position); `rootReleaseOrder` tells you which season you keyed on.",
    params: [
      { n: "slug", d: "path: anime slug or key", ex: "steins-gate-0-cbge5" },
      { n: "deep", d: "0 = only direct AniList relations (v2.5.1 behaviour); 1 = walk the whole franchise (default)", ex: "1" },
      { n: "art", d: "0 = skip poster/cover enrichment for this request", ex: "0" },
    ],
    try: "/api/watch-order/steins-gate-0-cbge5",
  },

  // ---- META ---------------------------------------------------------------
  {
    m: "GET",
    p: "/api/meta",
    d: "Rich canonical metadata (genres, studios, scores, trailer, external links, next-episode countdown) + playback availability for the anime.",
    params: [{ n: "key", d: "same key formats as /api/anime", ex: "anilist:154587" }],
    try: "/api/meta?key=anilist:154587",
  },
  {
    m: "GET",
    p: "/api/meta/characters",
    d: "Characters + their Japanese voice actors.",
    params: [
      { n: "key", d: "same key formats", ex: "frieren" },
      { n: "limit", d: "max characters returned", ex: "24" },
    ],
    try: "/api/meta/characters?key=frieren",
  },
  {
    m: "GET",
    p: "/api/meta/recommendations",
    d: "Top community recommendations, merged from AniList AND MAL — entries keep whatever identity their source provides (anilist:<id>, mal:<id> or slug) and are never dropped for missing ids.",
    params: [
      { n: "key", d: "same key formats", ex: "frieren" },
      { n: "limit", d: "max recommendations returned", ex: "12" },
    ],
    try: "/api/meta/recommendations?key=frieren",
  },
  {
    m: "GET",
    p: "/api/meta/season",
    d: "Seasonal anime grid with pagination (defaults to the current season).",
    params: [
      { n: "season", d: "WINTER | SPRING | SUMMER | FALL", ex: "SUMMER" },
      { n: "year", d: "e.g. 2026", ex: "2026" },
      { n: "page", d: "page number", ex: "1" },
    ],
    try: "/api/meta/season",
  },
  {
    m: "GET",
    p: "/api/meta/mal",
    d: "MyAnimeList-shaped details (queued + cached internally). Add &episodes=1 for the MAL episode list.",
    params: [
      { n: "key", d: "mal:<id> or any key that maps to a MAL id", ex: "mal:52991" },
      { n: "episodes", d: "1 = include MAL episode list", ex: "" },
    ],
    try: "/api/meta/mal?key=mal:52991",
  },
  {
    m: "GET",
    p: "/api/meta/external",
    d: "External links + legal streaming platforms listed on the MAL entry.",
    params: [{ n: "key", d: "mal:<id> or any key that maps to a MAL id", ex: "mal:52991" }],
    try: "/api/meta/external?key=mal:52991",
  },
  {
    m: "GET",
    p: "/api/meta/trending",
    d: "Banner-style view of what's airing now.",
    params: [],
    try: "/api/meta/trending",
  },
];

// ---------------------------------------------------------------------------
// System + env
// ---------------------------------------------------------------------------

const S = (m, p, d, params = [], extra = {}) => ({ m, p, d, params, ...extra });

export const SYSTEM_ENDPOINTS = [
  S("GET", "/", "Landing JSON with quick links", [], { try: "/" }),
  S("GET", "/api/health", "Uptime, version, cache stats, identity-index stats, optional-proxy status", [], { try: "/api/health" }),
  S("GET", "/api/docs", "This page. Browsers get the interactive HTML; API clients get JSON (or force with ?format=json)"),
  S("GET", "/api/docs.json", "Machine-readable catalog only", [], { try: "/api/docs.json" }),
  S("GET", "/api/openapi.json", "OpenAPI 3.1 spec generated from the same catalog as this page", [], { try: "/api/openapi.json" }),
  S("GET", "/download", "Download the full APIKuoshi source as a ZIP archive (served when KUOSHI_ZIP_PATH or ./apikuoshi-<version>.zip exists)", [], { try: "/download" }),
];

export const ENV_VARS = [
  { n: "PORT", def: "6969", d: "HTTP port of APIKuoshi." },
  { n: "DEDUP_THRESHOLD", def: "78", d: "Title-match strictness 0–100 for merging romaji/English duplicates in search results." },
  { n: "SOURCE_TIMEOUT_MS", def: "20000", d: "Internal fetch timeout per request phase." },
  { n: "CACHE_SECONDS", def: "180", d: "TTL of the response cache (0 disables)." },
  { n: "BROWSE_CACHE_SECONDS", def: "120", d: "v2.4.0: TTL for browse/catalog scrapes (trending, az-list, filter, …). 0 disables — every request re-scrapes upstream." },
  { n: "ENRICH_DEADLINE_MS", def: "4000", d: "v2.4.0: wall-clock cap on list art enrichment. Late provider fills ship on the next request instead of delaying the current one. 0 disables the cap." },
  { n: "IDENTITY_BACKFILL", def: "on", d: "v2.4.0: set to 0 to disable the background identity backfill queue (browse rows would then keep null anilistId/malId until another endpoint resolves them)." },
  { n: "RATE_LIMIT_MAX", def: "240", d: "Requests per window per IP (0 disables the limiter)." },
  { n: "RATE_LIMIT_WINDOW_MS", def: "60000", d: "Rate-limit window length." },
  { n: "ALLOWED_ORIGINS", def: "*", d: "CORS origins, comma-separated." },
  { n: "SOURCE_PRIORITY", def: "kaze,ishi", d: "Advanced: priority order of the internal data lanes. You normally never touch this." },
  { n: "MIRROR_DOMAINS", def: "auto", d: "OPTIONAL extra mirror domains for the catalogue lane (default set rotates automatically)." },
  { n: "STREAM_PROXY_DOMAINS", d: "OPTIONAL custom stream-proxy domains for playback extraction.", def: "auto" },
  { n: "STREAM_PROXY_REFERER", def: "https://megaplay.buzz/", d: "OPTIONAL Referer some stream CDNs require." },
  { n: "SCRAPER_API_KEY", def: "—", d: "OPTIONAL paid scraperapi key, picked up automatically if present. The API never requires it." },
  { n: "FLARESOLVERR_URL", def: "—", d: "OPTIONAL self-hosted FlareSolverr URL. Same deal: optional sugar, not a dependency." },
  { n: "TMDB_API_KEY", def: "—", d: "OPTIONAL TMDB v3 API key (free at themoviedb.org). Enables backdrop/logo art, season-aware posters and episode stills. Without it TMDB is skipped silently — Kitsu (keyless) still fills poster/cover." },
  { n: "ART_ENRICHMENT", def: "1", d: "Set 0 to disable the art-enrichment chain globally. Per-request alternative: &art=0 on any browse/catalog endpoint." },
  { n: "ENRICH_CONCURRENCY", def: "8", d: "Bounded parallelism (1–16) for list enrichment — never serializes 50 provider calls." },
];

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export function endpointCount() {
  return SYSTEM_ENDPOINTS.length + UNIFIED_ENDPOINTS.length;
}

/** Family grouping for the docs page + playground picker. */
const FAMILY_META = [
  { key: "core", label: "Core · search & identity", gc: "#f472b6", note: "Search, typeahead and title→key resolution. Deduplication is automatic." },
  { key: "anime", label: "Anime · info & episodes", gc: "#fbbf24", note: "Info, episode lists and server lists for any canonical key." },
  { key: "playback", label: "Playback · streams & downloads", gc: "#34d399", note: "The one-call /api/chain pipeline, watch/download resolvers, and the HLS/video/subtitle proxy infrastructure." },
  { key: "browse", label: "Browse · discovery", gc: "#67e8f9", note: "Trending, rankings, schedules, spotlight — everything for browsing UIs." },
  { key: "catalog", label: "Catalog · A–Z, filters, genres", gc: "#a78bfa", note: "Deep catalogue browsing by letter, facets, genre, type, status, seasons." },
  { key: "meta", label: "Meta · details", gc: "#f0abfc", note: "Rich metadata: characters, recommendations, seasons, MAL details, external links." },
  { key: "system", label: "System", gc: "#94a3b8", note: "Endpoints about APIKuoshi itself." },
];

function familyOf(p) {
  if (/^\/api\/(search|suggestions|resolve)/.test(p)) return "core";
  if (/^\/api\/anime/.test(p)) return "anime";
  if (/^\/api\/(watch|download|chain|proxy)/.test(p)) return "playback";
  if (/^\/api\/(az-list|filter|genre|type|status|seasons|watch-order)/.test(p)) return "catalog";
  if (/^\/api\/meta/.test(p)) return "meta";
  return "browse";
}

function groupedEndpoints() {
  const g = {};
  for (const f of FAMILY_META) g[f.key] = [];
  for (const e of UNIFIED_ENDPOINTS) g[familyOf(e.p)].push(e);
  return g;
}

export function buildCatalog(version) {
  return {
    success: true,
    api: "APIKuoshi",
    version,
    generatedAt: new Date().toISOString(),
    interactiveDocs: "/api/docs (open in a browser for the playground)",
    tagline: "One anime REST API — search, browse, stream.",
    concept: {
      oneSurface:
        "One endpoint set, one response schema. There is exactly one way to do each thing — search, browse, metadata, playback — and every endpoint answers in the same shape.",
      identity:
        "Every anime has one canonical key (anilist:<id> | mal:<id> | <id> | <title>). Any endpoint accepts any format and resolves it to the same resource.",
      availability:
        "Data is fetched live from public web sources through internal data lanes with automatic failover. If a lane is slow or empty, the next one serves the request — responses never expose the plumbing.",
      dedup:
        "Search anchors every result to a canonical entry; title signatures + Dice/Jaccard similarity (with season/type guards) merge romaji/English duplicates. Threshold: DEDUP_THRESHOLD.",
      streamingChain:
        "/api/chain is the one-call pipeline: search/id/slug in → resolve → info → episodes → servers → streams → CDN probe out. Nested functions inside one request, every hop timed in steps[], best playable stream at the end.",
      playback:
        "Streams are labeled direct (raw m3u8/mp4) or embed (player page). Every playback URL is also served through /api/proxy/* so browsers can play it cross-origin without extra setup.",
      optionalProxies:
        "SCRAPER_API_KEY / FLARESOLVERR_URL are OPTIONAL. APIKuoshi runs 100% free with no keys and no FlareSolverr.",
    },
    pipeline: PIPELINE,
    endpoints: groupedEndpoints(),
    allEndpoints: UNIFIED_ENDPOINTS,
    systemEndpoints: SYSTEM_ENDPOINTS,
    families: FAMILY_META.map(({ key, label, gc, note }) => ({ key, label, gc, note })),
    envVars: ENV_VARS,
    counts: { endpoints: endpointCount() },
  };
}
