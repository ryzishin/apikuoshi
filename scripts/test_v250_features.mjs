/**
 * ============================================================
 *  APIKuoshi — scripts/test_v250_features.mjs        v2.5.0
 * ============================================================
 *  Live verification of the v2.5.0 release surface:
 *    1. /proxy/subtitle  — Referer-default, format sniffing,
 *                          VTT→SRT + SRT→VTT conversion, raw mode
 *    2. /proxy/hls       — Referer-default + stale-token re-mint
 *    3. /proxy/video     — Referer-default segment fetch
 *    4. identity keys    — ?slug= support, identities block,
 *                          slug-preferred endpoint maps
 *    5. subtitle data    — proxiedUrl + proxiedSrtUrl in
 *                          /api/watch and /api/chain responses
 *
 *  Usage:  node scripts/test_v250_features.mjs [baseUrl]
 *          (default http://localhost:6969 — server must be running)
 * ============================================================
 */
const BASE = process.argv[2] || "http://localhost:6969";

let pass = 0, fail = 0;
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const get = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, { redirect: "follow", ...opts });
  const body = await r.text();
  return { status: r.status, headers: r.headers, body };
};
const enc = encodeURIComponent;
const j = (s) => { try { return JSON.parse(s); } catch { return null; } };

console.log(`\nAPIKuoshi v2.5.0 feature tests → ${BASE}\n` + "=".repeat(60));

// ---------------------------------------------------------------- setup
// 1. get a real, FRESH stream with subtitles through /api/watch
console.log("\n[setup] resolving a fresh stream with subtitles…");
const watch = j((await get("/api/watch?slug=frieren-beyond-journey-s-end-c6fbj&ep=1")).body);
const stream = watch?.stream || watch?.streams?.find((s) => s.subtitles?.length) || watch?.streams?.[0];
const sub = stream?.subtitles?.find((s) => s.proxiedSrtUrl) || stream?.subtitles?.[0];
const hlsUrl = stream?.url && stream.url.includes(".m3u8") ? stream.url : null;

if (!sub) { console.log("!! no subtitle track available — subtitle tests will be skipped"); }
if (!hlsUrl) { console.log("!! no HLS stream available — HLS tests will be skipped"); }

// ---------------------------------------------------------------- 1. subtitle proxy
console.log("\n[1] /api/proxy/subtitle");
if (sub) {
  // 1a. VTT default, NO ref — Referer-default must kick in (v2.4: 403)
  const vtt = await get(sub.proxiedUrl || `/api/proxy/subtitle?url=${enc(sub.url)}`);
  const isVtt = vtt.status === 200 && /^\uFEFF?WEBVTT/i.test(vtt.body);
  check("subtitle VTT default (no ref) returns 200 WEBVTT", isVtt,
    `status=${vtt.status} src=${vtt.headers.get("x-subtitle-source-format")}`);

  // 1b. SRT conversion
  const srtPath = sub.proxiedSrtUrl || `/api/proxy/subtitle?url=${enc(sub.url)}&format=srt`;
  const srt = await get(srtPath);
  const srtOk = srt.status === 200 &&
    /^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3} --> /.test(srt.body.trim()) &&
    srt.headers.get("x-subtitle-format") === "srt" &&
    srt.headers.get("x-subtitle-converted") === "1";
  check("subtitle ?format=srt converts VTT→SRT (counters + comma millis)", srtOk,
    `status=${srt.status} conv=${srt.headers.get("x-subtitle-converted")}`);

  // 1c. content-type
  check("subtitle SRT content-type application/x-subrip", /x-subrip/.test(srt.headers.get("content-type") || ""),
    srt.headers.get("content-type"));

  // 1d. raw passthrough
  const raw = await get(`/api/proxy/subtitle?url=${enc(sub.url)}&raw=1`);
  check("subtitle raw=1 passthrough 200", raw.status === 200 && raw.body.length > 100,
    `status=${raw.status} bytes=${raw.body.length}`);

  // 1e. ref=none gets rescued by the retry ladder
  const none = await get(`/api/proxy/subtitle?url=${enc(sub.url)}&ref=none`);
  check("subtitle ref=none rescued by Referer ladder", none.status === 200, `status=${none.status}`);

  // 1f. SRT round-trip stability: fetching twice yields identical bytes
  const srt2 = await get(srtPath);
  check("subtitle SRT deterministic across fetches", srt.body === srt2.body);

  // 1g. upstream url preserved
  check("subtitle track carries upstream url + proxied renditions",
    Boolean(sub.url && sub.proxiedUrl && sub.proxiedSrtUrl));
} else {
  check("subtitle track available from /api/watch", false, "no track found");
}

// ---------------------------------------------------------------- 2. HLS proxy
console.log("\n[2] /api/proxy/hls");
if (hlsUrl) {
  // 2a. no ref (Referer-default) — and a STALE token if the URL carries one
  const staleUrl = hlsUrl.includes("token=")
    ? hlsUrl.replace(/token=[^&]*/, "token=MTcwMDAwMDAwMHxzdGFsZQ.fake") // force stale
    : hlsUrl;
  const master = await get(`/api/proxy/hls?url=${enc(staleUrl)}`);
  const masterOk = master.status === 200 && master.body.includes("#EXTM3U");
  check("HLS master playlist (no ref + stale token) returns 200 #EXTM3U", masterOk,
    `status=${master.status}`);

  // 2b. rewritten child hops carry the proxy referer policy
  const firstChild = master.body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "";
  const childHasRef = firstChild.includes("/api/proxy/");
  check("HLS playlist rewrites child URIs through /api/proxy/*", childHasRef,
    firstChild.slice(0, 60));

  // 2c. follow the rewritten variant link
  if (childHasRef) {
    const variant = await get(firstChild.trim());
    const segLine = (variant.body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "").trim();
    check("HLS variant playlist fetches through rewritten link", variant.status === 200 && variant.body.includes("#EXTINF"),
      `status=${variant.status}`);
    // 2d. segment through /proxy/video (rewritten link)
    if (segLine.includes("/api/proxy/video")) {
      const seg = await get(segLine);
      check("HLS segment streams through rewritten /proxy/video link", seg.status === 200 && seg.body.length > 10000,
        `status=${seg.status} bytes=${seg.body.length}`);
    }
  }
} else {
  check("HLS stream URL available", false, "stream was not HLS this run");
}

// ---------------------------------------------------------------- 3. video proxy referer-default
console.log("\n[3] /api/proxy/video Referer-default");
if (sub) {
  // a HEAD-ish check: fetch a tiny range of the m3u8's own host root is meaningless,
  // so verify the video proxy against the real segment host with a bogus-but-valid
  // request: fetch the master playlist URL through /proxy/video (it serves text)
  if (hlsUrl) {
    const v = await get(`/api/proxy/video?url=${enc(hlsUrl)}`);
    check("video proxy (no ref) serves non-gated text URL", v.status === 200, `status=${v.status}`);
  }
}

// ---------------------------------------------------------------- 4. flexible identity keys
console.log("\n[4] flexible identity keys");
// 4a. ?slug= on /watch (was 400 in v2.4)
const wSlug = j((await get("/api/watch?slug=frieren-beyond-journey-s-end-c6fbj&ep=1")).body);
check("watch ?slug= accepted (no 400)", wSlug?.success === true, `status=${wSlug ? "parsed" : "unparsed"}`);

// 4b. identities block on /watch
check("watch identities.preferred = slug", wSlug?.identities?.preferred === "frieren-beyond-journey-s-end-c6fbj",
  JSON.stringify(wSlug?.identities?.preferred));
check("watch identities carries anilist+mal keys",
  wSlug?.identities?.keys?.anilist === "anilist:154587" && wSlug?.identities?.keys?.mal === "mal:52991");

// 4c. identities block on /anime
const anime = j((await get("/api/anime?key=frieren-beyond-journey-s-end-c6fbj")).body);
check("anime identities block present", Boolean(anime?.identities?.preferred),
  anime?.identities?.preferred || "missing");
check("anime endpoints map uses slug-preferred key",
  (anime?.endpoints?.watch || "").includes("key=frieren-beyond-journey-s-end-c6fbj"),
  anime?.endpoints?.watch || "missing");

// 4d. mal: key works through the flexible ladder
const wMal = j((await get("/api/watch?key=mal:52991&ep=1")).body);
check("watch ?key=mal:52991 resolves", wMal?.success === true, wMal?.key || "failed");

// 4e. anilist: key still works
const wAnilist = j((await get("/api/watch?key=anilist:154587&ep=1")).body);
check("watch ?key=anilist:154587 resolves", wAnilist?.success === true, wAnilist?.key || "failed");

// 4f. ?id= alias still works
const wId = j((await get("/api/watch?id=154587&ep=1")).body);
check("watch ?id=154587 alias resolves", wId?.success === true, wId?.key || "failed");

// ---------------------------------------------------------------- 5. chain
console.log("\n[5] /api/chain v2.5 data");
const chain = j((await get("/api/chain?slug=frieren-beyond-journey-s-end-c6fbj&ep=1&probe=0")).body);
check("chain succeeds", chain?.verdict !== undefined, chain?.verdict || "failed");
check("chain identities block slug-first", chain?.identities?.preferred === "frieren-beyond-journey-s-end-c6fbj",
  JSON.stringify(chain?.identities?.preferred));
const chainSub = chain?.streams?.find((s) => s.subtitles?.length)?.subtitles?.[0];
check("chain subtitle tracks carry proxiedUrl + proxiedSrtUrl",
  Boolean(chainSub?.proxiedUrl && chainSub?.proxiedSrtUrl),
  chainSub ? "ok" : "no subtitle tracks this run");
const chainUsage = chain?.usage?.watchEndpoint || "";
check("chain usage.watchEndpoint slug-preferred", chainUsage.includes("key=frieren-beyond-journey-s-end-c6fbj"),
  chainUsage.slice(0, 70));

// ---------------------------------------------------------------- summary
console.log("\n" + "=".repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail) { process.exit(1); }
