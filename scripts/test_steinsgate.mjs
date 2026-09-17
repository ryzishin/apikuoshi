/**
 * ============================================================
 *  Regression test — the Steins;Gate / Steins;Gate 0 incident
 * ============================================================
 *  v2.2.0 bug: titleSignature() dropped ALL bare digits, so
 *  "Steins;Gate" and "Steins;Gate 0" shared one signature and
 *  scored 100. Every identity decision then collapsed onto
 *  whichever listing upstream ranked first — both keys served
 *  Steins;Gate 0's 23 episodes and the original's 24-episode
 *  listing became unreachable.
 *
 *  This test pins the fix at THREE levels:
 *    1. pure functions  (titles.js)
 *    2. listing match   (keys.js matchSlug against the real kaze lane)
 *    3. resolver        (keys.js resolveIdentity for both spellings)
 *
 *  Run: node scripts/test_steinsgate.mjs
 * ============================================================
 */
import { titleSimilarity, titleSignature, titleExactness, pickBestBySimilarity } from "../src/core/titles.js";
import { matchSlug, resolveIdentity } from "../src/core/keys.js";
import { getLane } from "../src/core/registry.js";
import { anilistById } from "../src/core/anilist.js";
import config from "../src/config.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n== 1. pure functions (titles.js) ==");
check("S;G vs S;G0 are DIFFERENT anime (sim < dedupThreshold)",
  titleSimilarity("Steins;Gate", "Steins;Gate 0") < config.dedupThreshold,
  `sim=${titleSimilarity("Steins;Gate", "Steins;Gate 0")}, threshold=${config.dedupThreshold}`);
check("signatures differ", titleSignature("Steins;Gate") !== titleSignature("Steins;Gate 0"),
  `${JSON.stringify(titleSignature("Steins;Gate"))} vs ${JSON.stringify(titleSignature("Steins;Gate 0"))}`);
check("identical titles still score 100", titleSimilarity("Steins;Gate 0", "Steins;Gate 0") === 100);
check("year merge preserved (One Piece vs One Piece 2023)",
  titleSimilarity("One Piece", "One Piece 2023") >= config.dedupThreshold);
check("zero-padded numbers canonicalize (02 == 2)",
  titleSimilarity("Digimon Adventure 02", "Digimon Adventure 2") === 100);
check("exactness distinguishes the two shows",
  titleExactness("Steins;Gate", "Steins;Gate 0") === false &&
  titleExactness("Steins;Gate 0", "Steins;Gate 0") === true);

// the tie-break itself: S;G0 listed FIRST (the upstream order that broke 2.2.0)
const fakeResults = [
  { listingId: "steins-gate-0-cbge5", title: "Steins;Gate 0" },
  { listingId: "steins-gate-c93ww", title: "Steins;Gate" },
];
const pickSG = pickBestBySimilarity("Steins;Gate", fakeResults, (r) => titleSimilarity("Steins;Gate", r.title));
const pickSG0 = pickBestBySimilarity("Steins;Gate 0", fakeResults, (r) => titleSimilarity("Steins;Gate 0", r.title));
check("tie-break picks the EXACT title even when it is listed second",
  pickSG.best?.listingId === "steins-gate-c93ww" && pickSG0.best?.listingId === "steins-gate-0-cbge5",
  `S;G -> ${pickSG.best?.listingId}, S;G0 -> ${pickSG0.best?.listingId}`);

console.log("\n== 2. matchSlug against the real kaze lane ==");
// Synthetic canonicals (matchSlug reads title fields only) — keeps this test
// independent of AniList rate limits; the kaze lane is still fully live.
const kaze = getLane("kaze");
for (const [id, romaji, english, wantSlug, name] of [
  [9253, "Steins;Gate", "Steins;Gate", "steins-gate-c93ww", "Steins;Gate (original, 24 eps)"],
  [21127, "Steins;Gate 0", "Steins;Gate 0", "steins-gate-0-cbge5", "Steins;Gate 0 (23 eps)"],
]) {
  try {
    const canonical = { anilistId: id, malId: null, title: romaji, titleRomaji: romaji, titleEnglish: english };
    const match = await matchSlug(kaze, canonical, "");
    check(`anilist:${id} (${name}) matches its OWN listing`,
      match?.listingId === wantSlug,
      `got ${match?.listingId} (score ${match?.matchScore})`);
  } catch (e) {
    check(`anilist:${id} listing match`, false, e.message);
  }
}

console.log("\n== 3. resolveIdentity for both spellings ==");
const cooldown = async (ms) => new Promise((r) => setTimeout(r, ms));
for (const [input, wantId] of [
  ["Steins;Gate", 9253],
  ["Steins;Gate 0", 21127],
  ["anilist:9253", 9253],
  ["anilist:21127", 21127],
]) {
  let id = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { id = await resolveIdentity(input); break; }
    catch (e) { lastErr = e; await cooldown(20000); }
  }
  if (id) check(`resolveIdentity(${JSON.stringify(input)})`, id.anilistId === wantId,
    `anilistId=${id.anilistId}, via=${id.via}`);
  else check(`resolveIdentity(${JSON.stringify(input)})`, false, lastErr?.message || "unresolved");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
