#!/usr/bin/env node
/* v2.6.0 battery — comprehensive coverage of EVERY browse/discovery/detail
 * endpoint. Reports field-completeness per endpoint, save the raw results
 * to TEST_REPORT_V260.md.
 *
 * THE GOAL (from the user):
 *   "find a solution to solve missing keys like anilist, mal, or slugs.
 *    if we have data from other endpoints, whats the problem of getting
 *    data to fill empty or null data? ... for example /api/home, theres
 *    overlaps of same anime but didn't have a uniform data. apply it to
 *    all endpoints who share same data structure responses.
 *    find the part where the airing anime has episode schedule countdown
 *    allow the flexibility of identity keys to be used in apis, maybe
 *    advanced resolve?
 *    improve the browse and discovery api endpoints
 *    test them all and record data and summarize
 *    fix watch order, remove relations like Related, Side story, music, etc
 *    or group them so client can easily choose if they want it included
 *    or not depending on their needs"
 *
 * Usage:
 *   BASE=http://localhost:6969 node scripts/test_v260_features.mjs
 *   BASE=https://apikuoshi-v2.onrender.com node scripts/test_v260_features.mjs  # compare against live v2.5.2
 */
const BASE = process.env.BASE || "http://localhost:6969";
const TIMEOUT = 45000;
let PASS = 0, FAIL = 0, SKIP = 0;
const records = [];   // for the report

const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log(`  PASS  ${name}`); }
  else { FAIL++; console.log(`  FAIL  ${name}  ${detail || ""}`); }
};

async function j(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT) }).catch(e => null);
  if (!r) return { status: 0, body: null, ms: 0 };
  const t0 = Date.now();
  const body = await r.json().catch(() => null);
  const ms = Date.now() - t0;
  return { status: r.status, body, ms };
}

/** Extract the first results[] array (or top-level arrays for object-shaped responses). */
function getResults(body) {
  if (!body) return [];
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.data)) return body.data;
  if (body.data && typeof body.data === "object") {
    // object-shaped (home, top-ten, trending-sidebar) — flatten section arrays
    const out = [];
    for (const v of Object.values(body.data)) {
      if (Array.isArray(v) && v.length && v[0]?.slug) out.push(...v);
    }
    return out;
  }
  if (Array.isArray(body.suggestions)) return body.suggestions;
  return [];
}

/** Field-completeness meter — what % of rows have non-null values for the given field set. */
function completeness(rows, fields) {
  if (!rows.length) return { pct: 0, nonEmptyRows: 0, total: 0, perField: {} };
  const perField = {};
  for (const f of fields) {
    const nonEmpty = rows.filter(r => {
      const v = r?.[f];
      if (v == null || v === "" || v === 0) return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    }).length;
    perField[f] = Math.round((nonEmpty / rows.length) * 100);
  }
  // overall = rows where AT LEAST anilistId OR malId is present
  const idRows = rows.filter(r => r?.anilistId != null || r?.malId != null).length;
  return { pct: Math.round((idRows / rows.length) * 100), nonEmptyRows: idRows, total: rows.length, perField };
}

const IDENTITY_FIELDS = ["anilistId", "malId", "year", "season", "episodes", "score", "genres", "synonyms", "titleEnglish", "titleNative"];

async function probeEndpoint(name, path, { minRows = 1, requireFields = [] } = {}) {
  const r = await j(path);
  if (r.status !== 200) {
    ok(`${name} 200`, false, `status=${r.status} err=${r.body?.error || ""}`);
    records.push({ endpoint: name, path, status: r.status, completeness: null });
    return null;
  }
  ok(`${name} 200`, true);
  const rows = getResults(r.body);
  ok(`${name} returns >= ${minRows} rows`, rows.length >= minRows, `rows=${rows.length}`);
  if (!rows.length) {
    records.push({ endpoint: name, path, status: r.status, rows: 0, completeness: null });
    return rows;
  }
  const c = completeness(rows, IDENTITY_FIELDS);
  records.push({ endpoint: name, path, status: r.status, rows: rows.length, completeness: c });
  console.log(`         rows=${rows.length}  id-completeness=${c.pct}%  perField=${JSON.stringify(c.perField)}`);
  if (requireFields.length) {
    for (const f of requireFields) {
      const present = rows.filter(r => r?.[f] != null).length;
      ok(`${name} has ${f} on at least 1 row`, present > 0, `present on ${present}/${rows.length}`);
    }
  }
  return rows;
}

(async () => {
  console.log(`== v2.6.0 battery — BASE=${BASE} ==\n`);

  // 1. /api/health — version + merge layer flag
  console.log("== 1. /api/health ==");
  const h = await j("/api/health");
  ok("health 200", h.status === 200);
  ok("version is 2.6.0", h.body?.version === "2.6.0", `version=${h.body?.version}`);
  ok("enrichment.merge present", h.body?.enrichment?.merge?.includes("v2.6.0"), `value=${h.body?.enrichment?.merge}`);

  // 2. /api/home — cross-section merge so shared slugs carry the union
  console.log("\n== 2. /api/home — cross-section merge ==");
  const home = await j("/api/home");
  ok("home 200", home.status === 200);
  const homeSections = home.body?.data || {};
  const sectionNames = Object.keys(homeSections).filter(k => Array.isArray(homeSections[k]) && homeSections[k].length && homeSections[k][0]?.slug);
  ok("home has 2+ anime sections", sectionNames.length >= 2, `sections=${sectionNames.join(",")}`);
  // Check cross-section slug overlap + field consistency
  if (sectionNames.length >= 2) {
    const bySlug = new Map();
    for (const s of sectionNames) {
      for (const r of homeSections[s]) {
        if (!bySlug.has(r.slug)) bySlug.set(r.slug, { sections: new Set(), fields: new Set() });
        bySlug.get(r.slug).sections.add(s);
        for (const k of Object.keys(r)) bySlug.get(r.slug).fields.add(k);
      }
    }
    const shared = [...bySlug.entries()].filter(([_, v]) => v.sections.size >= 2);
    ok("home has shared slugs across 2+ sections", shared.length > 0, `shared=${shared.length}`);
    if (shared.length) {
      // For each shared slug, the row in EVERY section should carry the union of fields
      let consistent = 0;
      for (const [slug, info] of shared) {
        const fieldsPerSection = sectionNames.map(s => new Set(homeSections[s].filter(r => r.slug === slug).map(r => Object.keys(r)).flat()));
        const union = new Set();
        fieldsPerSection.forEach(s => s.forEach(f => union.add(f)));
        // Check: does each section that contains this slug carry ALL union fields?
        const allCarry = fieldsPerSection.every(s => union.size === 0 || [...union].every(f => s.has(f) || homeSections[sectionNames[0]].find(r => r.slug === slug)?.[f] == null));
        if (allCarry) consistent++;
      }
      ok("shared slugs carry union of fields across sections", consistent > 0, `consistent=${consistent}/${shared.length}`);
    }
  }

  // 3. Browse/discovery endpoints — field completeness
  console.log("\n== 3. Browse/discovery — field completeness ==");
  await probeEndpoint("trending", "/api/trending", { minRows: 3 });
  await probeEndpoint("popular", "/api/popular", { minRows: 3 });
  await probeEndpoint("spotlight", "/api/spotlight", { minRows: 1 });
  await probeEndpoint("top-ten", "/api/top-ten", { minRows: 1 });
  await probeEndpoint("top-rankings", "/api/top-rankings?sort=top", { minRows: 3 });
  await probeEndpoint("trending-sidebar", "/api/trending-sidebar", { minRows: 1 });
  await probeEndpoint("upcoming", "/api/upcoming", { minRows: 1 });
  await probeEndpoint("completed", "/api/completed", { minRows: 1 });
  await probeEndpoint("new-release", "/api/new-release", { minRows: 1 });
  await probeEndpoint("newly-added", "/api/newly-added", { minRows: 1 });
  await probeEndpoint("latest-updated", "/api/latest-updated", { minRows: 1 });
  await probeEndpoint("recently-updated", "/api/recently-updated?tab=all", { minRows: 1 });
  await probeEndpoint("az-list", "/api/az-list/a", { minRows: 3 });
  await probeEndpoint("filter", "/api/filter?type=TV", { minRows: 3 });
  await probeEndpoint("genre", "/api/genre/action", { minRows: 3 });
  await probeEndpoint("type", "/api/type/TV", { minRows: 3 });
  await probeEndpoint("status", "/api/status/airing", { minRows: 3 });

  // 4. /api/schedule — airingAt countdown (from kaze extractor)
  console.log("\n== 4. /api/schedule — airing countdown ==");
  const sch = await probeEndpoint("schedule", "/api/schedule", { minRows: 1, requireFields: ["airingAt"] });
  const schToday = await probeEndpoint("schedule?date=today", "/api/schedule?date=" + new Date().toISOString().slice(0, 10), { minRows: 1 });

  // 5. /api/airing — nextAiringEpisode from AniList season-now (with kaze
  // airingAt fallback when AniList is rate-limited)
  console.log("\n== 5. /api/airing — nextAiringEpisode OR airingAt countdown ==");
  const ar = await probeEndpoint("airing", "/api/airing", { minRows: 1 });
  if (ar && ar.length) {
    // The AniList path (preferred) — nextAiringEpisode.airingAt
    const withNextAiring = ar.filter(r => r.nextAiringEpisode != null && r.nextAiringEpisode.airingAt != null);
    // The kaze fallback path — airingAt computed from the time string
    const withAiringAt = ar.filter(r => r.airingAt != null);
    ok("airing has airingAt (kaze path) on at least 1 row", withAiringAt.length > 0, `with=${withAiringAt.length}/${ar.length}`);
    // nextAiringEpisode depends on AniList being reachable — log only
    console.log(`         nextAiringEpisode (AniList path): ${withNextAiring.length}/${ar.length} rows  (AniList rate-limits may suppress this)`);
  }

  // 6. /api/anime and /api/meta — merge layer top-up (nextAiringEpisode, duration, studios)
  console.log("\n== 6. /api/anime + /api/meta — detail merge ==");
  const searchRes = await j("/api/search?q=frieren");
  const firstKey = searchRes.body?.results?.[0]?.key;
  ok("search returned a key", Boolean(firstKey), `key=${firstKey}`);
  if (firstKey) {
    const an = await j("/api/anime?key=" + encodeURIComponent(firstKey));
    ok("anime 200", an.status === 200);
    const a = an.body?.anime || {};
    ok("anime carries nextAiringEpisode (null or obj)", "nextAiringEpisode" in a, `keys=${Object.keys(a).slice(0,20).join(",")}`);
    ok("anime carries duration", "duration" in a);
    ok("anime carries averageScore", "averageScore" in a);
    ok("anime carries studios (array)", Array.isArray(a.studios));
    ok("anime carries trailer", "trailer" in a);
    const me = await j("/api/meta?key=" + encodeURIComponent(firstKey));
    ok("meta 200", me.status === 200);
    const ma = me.body?.anime || {};
    ok("meta carries nextAiringEpisode", "nextAiringEpisode" in ma);
    ok("meta carries duration", "duration" in ma);
    // Both surfaces carry IDENTICAL values for these v2.6.0 fields
    ok("anime vs meta nextAiringEpisode match", JSON.stringify(a.nextAiringEpisode) === JSON.stringify(ma.nextAiringEpisode),
      `anime=${JSON.stringify(a.nextAiringEpisode)?.slice(0,80)}  meta=${JSON.stringify(ma.nextAiringEpisode)?.slice(0,80)}`);
    ok("anime vs meta duration match", a.duration === ma.duration, `anime=${a.duration} meta=${ma.duration}`);
  }

  // 7. /api/resolve — advanced resolve (via + advanced fields)
  console.log("\n== 7. /api/resolve — advanced ladder ==");
  const rs = await j("/api/resolve?title=frieren&advanced=1");
  ok("resolve?advanced=1 200", rs.status === 200, `status=${rs.status}`);
  ok("resolve returns via field", "via" in (rs.body || {}), `body=${JSON.stringify(rs.body).slice(0,200)}`);
  ok("resolve returns advanced=true field", rs.body?.advanced === true, `advanced=${rs.body?.advanced}`);
  const rsPlain = await j("/api/resolve?title=frieren");
  ok("resolve (plain) 200", rsPlain.status === 200);
  ok("resolve (plain) doesn't set advanced=true", rsPlain.body?.advanced === false, `advanced=${rsPlain.body?.advanced}`);

  // 8. Watch-order filters
  console.log("\n== 8. Watch-order filters ==");
  // Find a known multi-season key
  const sgr = await j("/api/search?q=steins+gate");
  const sgKey = sgr.body?.results?.find(r => r.title?.includes("Steins;Gate 0"))?.key || sgr.body?.results?.[0]?.key;
  ok("found a Steins;Gate test key", Boolean(sgKey), `key=${sgKey}`);
  if (sgKey) {
    const woDefault = await j("/api/watch-order/" + encodeURIComponent(sgKey));
    ok("watch-order 200", woDefault.status === 200);
    ok("watch-order has filter block", "filter" in (woDefault.body || {}));
    ok("watch-order default excludes 'related'", woDefault.body?.filter?.defaulted === true && woDefault.body?.filter?.exclude?.includes("related"),
      `filter=${JSON.stringify(woDefault.body?.filter)}`);
    const woExclude = await j("/api/watch-order/" + encodeURIComponent(sgKey) + "?exclude=related,sideStory");
    ok("watch-order?exclude=related,sideStory 200", woExclude.status === 200);
    ok("watch-order?exclude drops 'related' from groups", !woExclude.body?.groups?.related, `groups=${Object.keys(woExclude.body?.groups || {}).join(",")}`);
    ok("watch-order?exclude drops 'sideStory' from groups", !woExclude.body?.groups?.sideStory);
    const woInclude = await j("/api/watch-order/" + encodeURIComponent(sgKey) + "?include=prequel,sequel");
    ok("watch-order?include=prequel,sequel 200", woInclude.status === 200);
    const incBuckets = Object.keys(woInclude.body?.groups || {});
    ok("watch-order?include keeps only prequel+sequel (+ self)",
      incBuckets.every(b => b === "prequel" || b === "sequel") || incBuckets.length === 0,
      `groups=${incBuckets.join(",")}`);
    // Self always survives
    const selfSurvives = (woInclude.body?.watchOrder || []).some(e => e.relation === "self");
    ok("watch-order?include keeps self (You are here)", selfSurvives);
  }

  // 9. Seasons filter — same behavior
  console.log("\n== 9. Seasons filters ==");
  if (sgKey) {
    const seDefault = await j("/api/seasons/" + encodeURIComponent(sgKey));
    ok("seasons 200", seDefault.status === 200);
    ok("seasons default excludes 'related'", seDefault.body?.filter?.defaulted === true);
    const seExclude = await j("/api/seasons/" + encodeURIComponent(sgKey) + "?exclude=related,sideStory");
    ok("seasons?exclude 200", seExclude.status === 200);
    ok("seasons?exclude drops 'related'", !seExclude.body?.groups?.related);
    ok("seasons?exclude drops 'sideStory'", !seExclude.body?.groups?.sideStory);
  }

  // 10. Regression — playback + chain untouched
  console.log("\n== 10. Regression — playback untouched ==");
  if (firstKey) {
    const wa = await j("/api/watch?key=" + encodeURIComponent(firstKey) + "&ep=1");
    ok("watch 200", wa.status === 200 && wa.body?.success === true);
    const ep = await j("/api/anime/episodes?key=" + encodeURIComponent(firstKey));
    ok("episodes 200", ep.status === 200);
    const ch = await j("/api/chain?key=" + encodeURIComponent(firstKey) + "&ep=1");
    ok("chain 200", ch.status === 200 && ch.body?.success === true);
  }
  const sr = await j("/api/search?q=frieren");
  ok("search 200", sr.status === 200 && sr.body?.count > 0);
  const su = await j("/api/suggestions?keyword=frieren");
  ok("suggestions 200", su.status === 200 && su.body?.count > 0);

  console.log(`\n==== RESULT: ${PASS} PASS · ${FAIL} FAIL · ${SKIP} SKIP ====`);

  // Write the field-completeness report to TEST_REPORT_V260.md
  const report = [
    "# v2.6.0 — field-completeness report",
    "",
    `Base: ${BASE}`,
    `Generated: ${new Date().toISOString()}`,
    `Result: ${PASS} PASS · ${FAIL} FAIL · ${SKIP} SKIP`,
    "",
    "## Per-endpoint field completeness",
    "",
    "| Endpoint | Path | Status | Rows | ID-complete % | anilistId % | malId % | year % | season % | episodes % | score % | genres % | synonyms % | titleEnglish % | titleNative % |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const rec of records) {
    if (!rec.completeness || typeof rec.completeness !== "object") {
      report.push(`| ${rec.endpoint} | ${rec.path} | ${rec.status || 0} | ${rec.rows || 0} | — | — | — | — | — | — | — | — | — | — | — |`);
      continue;
    }
    const c = rec.completeness;
    const pf = c.perField || {};
    report.push(`| ${rec.endpoint} | ${rec.path} | ${rec.status || 0} | ${c.total} | ${c.pct}% | ${pf.anilistId || 0}% | ${pf.malId || 0}% | ${pf.year || 0}% | ${pf.season || 0}% | ${pf.episodes || 0}% | ${pf.score || 0}% | ${pf.genres || 0}% | ${pf.synonyms || 0}% | ${pf.titleEnglish || 0}% | ${pf.titleNative || 0}% |`);
  }
  report.push("", "## Summary", "");
  report.push(`- Endpoints tested: ${records.length}`);
  report.push(`- Endpoints returning 200: ${records.filter(r => r.status === 200).length}`);
  report.push(`- Endpoints with >= 80% id-completeness: ${records.filter(r => r.completeness && r.completeness.pct >= 80).length}`);
  report.push(`- Endpoints with >= 50% anilistId: ${records.filter(r => r.completeness && (r.completeness.perField?.anilistId || 0) >= 50).length}`);
  report.push(`- Endpoints with >= 50% year: ${records.filter(r => r.completeness && (r.completeness.perField?.year || 0) >= 50).length}`);
  report.push(`- Endpoints with >= 50% score: ${records.filter(r => r.completeness && (r.completeness.perField?.score || 0) >= 50).length}`);
  report.push("");
  const fs = await import("fs");
  fs.writeFileSync("TEST_REPORT_V260.md", report.join("\n"), "utf8");
  console.log("\nField-completeness report written to TEST_REPORT_V260.md");
  console.log(`Records captured: ${records.length} (statuses: ${records.map(r => r.status).join(",")})`);

  process.exit(FAIL ? 1 : 0);
})();
