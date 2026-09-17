/**
 * Diagnostic: does kaze upstream carry BOTH Steins;Gate listings,
 * and in what order does search return them?
 * Read-only probe — hits the upstream extractors directly.
 */
import { getLane } from "../src/core/registry.js";

const kaze = getLane("kaze");
if (!kaze) { console.error("kaze lane unavailable"); process.exit(1); }

for (const q of ["Steins;Gate", "Steins;Gate 0"]) {
  try {
    const results = await kaze.search(q, 1);
    console.log(`\n=== kaze.search(${JSON.stringify(q)}) ===`);
    for (const r of (results || []).slice(0, 8)) {
      console.log(JSON.stringify({
        listingId: r.listingId,
        title: r.title,
        type: r.type,
        episodes: r.episodes ?? r.total ?? null,
      }));
    }
  } catch (e) {
    console.error(`search(${q}) failed:`, e.message);
  }
}

// also try the direct listing info for both candidate slugs
for (const slug of ["steins-gate", "steins-gate-0", "steinsgate", "steinsgate-0"]) {
  try {
    const info = await kaze.info(slug);
    console.log(`\nkaze.info(${slug}) =>`, JSON.stringify({
      title: info?.title ?? null,
      episodes: info?.episodes ?? null,
      type: info?.type ?? null,
    }));
  } catch (e) {
    console.log(`kaze.info(${slug}) => FAIL:`, e.message);
  }
}
process.exit(0);
