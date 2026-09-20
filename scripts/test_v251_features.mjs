#!/usr/bin/env node
/* v2.5.1 battery 3: post-fix verification of all three core endpoints */
const BASE = process.env.BASE || "http://localhost:6969";
let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log(`  PASS  ${name}`); }
  else { FAIL++; console.log(`  FAIL  ${name}  ${detail || ""}`); }
};

async function j(path) {
  const r = await fetch(BASE + path);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

(async () => {
  console.log("== 1. /api/suggestions parity with /api/search ==");
  for (const term of ["frieren", "dandadan", "one pie", "spy x family"]) {
    const s = await j(`/api/search?q=${encodeURIComponent(term)}`);
    const g = await j(`/api/suggestions?keyword=${encodeURIComponent(term)}`);
    const r1 = s.body.results || [], r2 = g.body.suggestions || [];
    ok(`[${term}] count parity`, r1.length === r2.length, `search=${r1.length} sugg=${r2.length}`);
    ok(`[${term}] first item identical`, JSON.stringify(r1[0]) === JSON.stringify(r2[0]));
    ok(`[${term}] full arrays identical`, JSON.stringify(r1) === JSON.stringify(r2));
    ok(`[${term}] results key parity`, JSON.stringify(g.body.results) === JSON.stringify(g.body.suggestions));
    ok(`[${term}] envelope fields`, g.body.keyword === term && g.body.query === term && g.body.page === s.body.page);
  }
  const lim = await j("/api/suggestions?keyword=one%20piece&limit=5");
  ok("limit=5 trims", lim.body.count === 5 && lim.body.suggestions.length === 5, `count=${lim.body.count}`);
  const sugQ = await j("/api/suggestions?q=dandadan");
  ok("suggestions ?q= alias", sugQ.status === 200 && sugQ.body.count > 0);
  const sug400 = await j("/api/suggestions");
  ok("suggestions empty -> 400", sug400.status === 400);

  console.log("\n== 2. /api/resolve accepts every param name ==");
  const params = [
    ["title", "frieren"], ["q", "frieren"], ["key", "anilist:154587"],
    ["query", "frieren"], ["keyword", "frieren"],
    ["slug", "frieren-beyond-journeys-end"], ["anilist", "154587"],
    ["mal", "50265"], ["id", "154587"], ["name", "frieren"],
  ];
  for (const [p, v] of params) {
    const r = await j(`/api/resolve?${p}=${encodeURIComponent(v)}`);
    const good = r.status === 200 && r.body.success && r.body.found;
    ok(`?${p}=${v}`, good, `status=${r.status} err=${r.body?.error || r.body?.message || ""}`);
  }
  const al = await j("/api/resolve?anilist=154587");
  ok("?anilist= resolves frieren", al.body.key === "anilist:154587", al.body.key);
  const sl = await j("/api/resolve?slug=frieren-beyond-journeys-end");
  ok("?slug= keeps request slug", sl.body.anime?.slug === "frieren-beyond-journeys-end", sl.body.anime?.slug);
  const empty = await j("/api/resolve");
  ok("resolve empty -> 400", empty.status === 400);

  console.log("\n== 3. /api/resolve key formats ==");
  const fmts = [
    ["slug:frieren-beyond-journeys-end", "anilist:154587"],
    ["https://anilist.co/anime/154587", "anilist:154587"],
    ["https://myanimelist.net/anime/50265", "anilist:140960"],
    ["https://kazescure.com/watch/frieren-beyond-journeys-end", "anilist:154587"],
  ];
  for (const [input, wantKey] of fmts) {
    const r = await j(`/api/resolve?title=${encodeURIComponent(input)}`);
    ok(`${input}`, r.status === 200 && r.body.key === wantKey, `status=${r.status} key=${r.body?.key} err=${r.body?.error || ""}`);
  }
  const junk = await j("/api/resolve?title=zzzznotarealanime999");
  ok("garbage -> honest 404", junk.status === 404 && junk.body.success === false);

  console.log("\n== 4. native/CJK title anchoring ==");
  const jp = await j("/api/resolve?title=" + encodeURIComponent("葬送のフリーレン"));
  ok("葬送のフリーレン -> main series 154587", jp.status === 200 && jp.body.key === "anilist:154587",
    `status=${jp.status} key=${jp.body?.key}`);
  const jp2 = await j("/api/resolve?title=" + encodeURIComponent("ワンピース"));
  ok("ワンピース resolves", jp2.status === 200 && jp2.body.found, `status=${jp2.status} key=${jp2.body?.key}`);

  console.log("\n== 5. regression: search & anime & watch still fine ==");
  const sr = await j("/api/search?q=steins;gate");
  ok("search steins;gate ok", sr.status === 200 && sr.body.count > 0);
  const an = await j("/api/anime?key=anilist:154587");
  ok("anime by anilist key", an.status === 200 && an.body.success && (an.body.anime?.title || an.body.anime?.key));
  const anSlug = await j("/api/anime?slug=frieren-beyond-journeys-end");
  ok("anime by slug", anSlug.status === 200 && anSlug.body.success);
  const wa = await j("/api/watch?slug=frieren-beyond-journeys-end&ep=1");
  ok("watch by slug", wa.status === 200 && wa.body.success);
  const az = await j("/api/home");
  ok("home untouched", az.status === 200 && az.body.success);
  const pop = await j("/api/popular");
  ok("popular untouched", pop.status === 200 && pop.body.success && (pop.body.count ?? pop.body.results?.length ?? 0) > 0);

  console.log(`\n==== RESULT: ${PASS} PASS · ${FAIL} FAIL ====`);
  process.exit(FAIL ? 1 : 0);
})();
