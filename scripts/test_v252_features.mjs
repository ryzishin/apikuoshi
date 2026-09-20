#!/usr/bin/env node
/* v2.5.2 battery: watch-order transitive franchise walk
 *
 * Reproduces the reported bug against ANY BASE (defaults to localhost:6969,
 * but accepts BASE=https://apikuoshi-v2.onrender.com to verify the v2.5.1
 * pre-fix state, then re-run against a local v2.5.2 instance for after).
 *
 * THE BUG:
 *   watch-order on a sequel/season-N used to return only that entry's
 *   DIRECT AniList relations, missing the parent show (because AniList
 *   stores edges on one side — SG→SEQUEL→SG0 lives on SG's record, NOT
 *   on SG0's, so calling watch-order on SG0 missed SG entirely).
 *
 * AFTER THE FIX:
 *   watch-order walks the relations graph transitively (BFS, depth 3,
 *   max 40 nodes) and returns the COMPLETE franchise — every season,
 *   OVA, movie, side-story — regardless of which entry was keyed on.
 *   New fields: watchOrder[], releaseOrder, rootReleaseOrder, root,
 *   totalInFranchise. ?deep=0 keeps the v2.5.1 behaviour.
 */
const BASE = process.env.BASE || "http://localhost:6969";
let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log(`  PASS  ${name}`); }
  else { FAIL++; console.log(`  FAIL  ${name}  ${detail || ""}`); }
};

async function j(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) }).catch((e) => null);
  if (!r) return { status: 0, body: null };
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

const slugByAnilist = (body, id) => (body?.related || body?.watchOrder || body?.seasons || [])
  .find((e) => String(e.anilistId) === String(id));

(async () => {
  console.log(`== v2.5.2 watch-order fix — BASE=${BASE} ==\n`);

  // ---------------------------------------------------------------- 1. SG0
  console.log("== 1. Steins;Gate 0 (anilist:21127) — the original bug report ==");
  const sg0 = await j("/api/watch-order/anilist:21127");
  ok("status 200", sg0.status === 200, `status=${sg0.status}`);
  ok("kind watch-order", sg0.body?.kind === "watch-order");
  ok("source upgraded (anilist-franchise)", sg0.body?.source === "anilist-franchise",
    `source=${sg0.body?.source}  (v2.5.1 returns 'anilist-relations')`);

  // THE bug fix: the original Steins;Gate (anilist:9253) MUST be present.
  const hasSG = slugByAnilist(sg0.body, 9253);
  ok("original Steins;Gate (9253) present", Boolean(hasSG),
    "v2.5.1 missed it entirely — SG0's prequel was stored on SG's record");
  ok("SG labelled prequel", hasSG?.relation === "prequel",
    `relation=${hasSG?.relation}`);

  // New fields
  ok("watchOrder[] present", Array.isArray(sg0.body?.watchOrder) && sg0.body.watchOrder.length > 0,
    `len=${sg0.body?.watchOrder?.length}`);
  ok("rootReleaseOrder present", Number.isFinite(sg0.body?.rootReleaseOrder),
    `value=${sg0.body?.rootReleaseOrder}`);
  ok("root.relation='self'", sg0.body?.root?.relation === "self",
    `relation=${sg0.body?.root?.relation}`);
  ok("totalInFranchise >= 3", (sg0.body?.totalInFranchise ?? 0) >= 3,
    `total=${sg0.body?.totalInFranchise}`);
  ok("related[] grew vs v2.5.1 (was 2)", (sg0.body?.related?.length ?? 0) > 2,
    `related=${sg0.body?.related?.length}`);

  // releaseOrder must be 1..N with no gaps or duplicates, root's slot matches rootReleaseOrder
  const orders = (sg0.body?.watchOrder || []).map((e) => e.releaseOrder).filter(Number.isFinite);
  const uniqueSorted = [...new Set(orders)].sort((a, b) => a - b);
  ok("releaseOrder 1..N contiguous", uniqueSorted.length === orders.length &&
    uniqueSorted[0] === 1 && uniqueSorted[uniqueSorted.length - 1] === orders.length,
    `orders=${JSON.stringify(orders)}`);
  const rootInWatch = (sg0.body?.watchOrder || []).find((e) => e.relation === "self");
  ok("root's releaseOrder == rootReleaseOrder",
    Boolean(rootInWatch) && rootInWatch.releaseOrder === sg0.body.rootReleaseOrder,
    `root=${rootInWatch?.releaseOrder}  field=${sg0.body?.rootReleaseOrder}`);

  // watchOrder sorted by year ascending
  const yearsAsc = (sg0.body?.watchOrder || [])
    .map((e) => e.year).filter(Number.isFinite);
  const sorted = [...yearsAsc].sort((a, b) => a - b);
  ok("watchOrder sorted by year asc", JSON.stringify(yearsAsc) === JSON.stringify(sorted),
    `years=${JSON.stringify(yearsAsc)}`);

  // ------------------------------------------------------- 2. Mushoku S3
  console.log("\n== 2. Mushoku Tensei Season 3 (anilist:178789) — 1 entry → full franchise ==");
  const m3 = await j("/api/watch-order/anilist:178789");
  ok("status 200", m3.status === 200);
  ok("related[] grew from 1 (v2.5.1) → >= 3", (m3.body?.related?.length ?? 0) >= 3,
    `related=${m3.body?.related?.length}`);

  const hasS1 = slugByAnilist(m3.body, 108465);
  const hasS2 = slugByAnilist(m3.body, 146065);
  const hasS2P2 = slugByAnilist(m3.body, 166873);
  ok("S1 (108465) present", Boolean(hasS1));
  ok("S2 (146065) present", Boolean(hasS2));
  ok("S2P2 (166873) present", Boolean(hasS2P2));
  ok("S1 labelled prequel (transitive inference)", hasS1?.relation === "prequel",
    `relation=${hasS1?.relation}`);
  ok("S2 labelled prequel (transitive inference)", hasS2?.relation === "prequel",
    `relation=${hasS2?.relation}`);
  ok("S2P2 labelled prequel (direct)", hasS2P2?.relation === "prequel",
    `relation=${hasS2P2?.relation}`);
  ok("rootReleaseOrder points to S3's slot",
    m3.body?.rootReleaseOrder === (m3.body?.watchOrder || [])
      .find((e) => e.relation === "self")?.releaseOrder,
    `root=${m3.body?.rootReleaseOrder}`);

  // --------------------------------------- 3. symmetry — call on the parent
  console.log("\n== 3. Symmetry — call watch-order on the parent Steins;Gate (9253) ==");
  const sg1 = await j("/api/watch-order/anilist:9253");
  ok("status 200", sg1.status === 200);
  const sg0FromRoot = slugByAnilist(sg1.body, 21127);
  ok("SG0 (21127) present when calling from SG", Boolean(sg0FromRoot));
  ok("SG0 labelled sequel (direct edge)", sg0FromRoot?.relation === "sequel",
    `relation=${sg0FromRoot?.relation}`);
  // The franchise sets from SG and SG0 should overlap heavily (>= 3 shared ids).
  const idsFromSG0 = new Set((sg0.body?.watchOrder || []).map((e) => e.anilistId).filter(Boolean));
  const idsFromSG1 = new Set((sg1.body?.watchOrder || []).map((e) => e.anilistId).filter(Boolean));
  const overlap = [...idsFromSG0].filter((id) => idsFromSG1.has(id)).length;
  ok("franchise sets overlap >= 3", overlap >= 3, `overlap=${overlap}`);

  // --------------------------------------------------------- 4. ?deep=0
  console.log("\n== 4. ?deep=0 — opt-out keeps the v2.5.1 behaviour ==");
  const sg0shallow = await j("/api/watch-order/anilist:21127?deep=0");
  ok("status 200", sg0shallow.status === 200);
  ok("source reverts to anilist-relations", sg0shallow.body?.source === "anilist-relations",
    `source=${sg0shallow.body?.source}`);
  ok("related[] back to direct-only (<= 3)", (sg0shallow.body?.related?.length ?? 0) <= 3,
    `related=${sg0shallow.body?.related?.length}`);
  ok("original Steins;Gate ABSENT in shallow mode (matches v2.5.1)",
    !slugByAnilist(sg0shallow.body, 9253));

  // ---------------------------------------------------- 5. /api/seasons
  console.log("\n== 5. /api/seasons — same franchise walk, seasons shape ==");
  const seasons = await j("/api/seasons/anilist:178789");
  ok("status 200", seasons.status === 200);
  ok("kind seasons", seasons.body?.kind === "seasons");
  ok("seasons[] grew (>= 3)", (seasons.body?.seasons?.length ?? 0) >= 3,
    `seasons=${seasons.body?.seasons?.length}`);
  ok("root present with relation='self'", seasons.body?.root?.relation === "self",
    `relation=${seasons.body?.root?.relation}`);
  ok("S1 present in seasons", Boolean((seasons.body?.seasons || [])
    .find((e) => String(e.anilistId) === "108465")));

  // ----------------------------------------------- 6. regressions (untouched)
  console.log("\n== 6. Regression — other endpoints untouched ==");
  const sr = await j("/api/search?q=steins;gate");
  ok("search ok", sr.status === 200 && sr.body?.count > 0);
  const an = await j("/api/anime?key=anilist:154587");
  ok("anime by anilist key ok", an.status === 200 && an.body?.success);
  const wa = await j("/api/watch?slug=frieren-beyond-journeys-end&ep=1");
  ok("watch by slug ok", wa.status === 200 && wa.body?.success);
  const home = await j("/api/home");
  ok("home ok", home.status === 200 && home.body?.success);
  const pop = await j("/api/popular");
  ok("popular ok", pop.status === 200 && pop.body?.success);
  const meta = await j("/api/meta?key=anilist:154587");
  ok("meta ok", meta.status === 200 && meta.body?.success);

  console.log(`\n==== RESULT: ${PASS} PASS · ${FAIL} FAIL ====`);
  process.exit(FAIL ? 1 : 0);
})();
