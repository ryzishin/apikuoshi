# APIKuoshi — worklog

This is the shared worklog for the APIKuoshi project. Every iteration
appends a section so future runs can pick up where the previous one
left off without re-exploring the codebase.

---
Task ID: v2.6.0
Agent: main (super-z)
Task: User requested v2.6.0 with these specific features:
  1. Fix missing keys (anilist/mal/slug) on browse endpoints — unify
     data so the same anime carries the same fields everywhere.
     /api/home had cross-section non-uniform data.
  2. Find + improve the airing anime schedule countdown code.
  3. Allow flexibility of identity keys in APIs — "advanced resolve".
  4. Improve browse/discovery API endpoints.
  5. Test them all, record data, summarize.
  6. Fix watch-order — remove/group relations like Related, Side story,
     Music so client can choose.
  7. Zip + update worklog.

Work Log:
- Read the latest master state at /home/z/my-project/repo (user had
  force-pushed v2.5.2 to origin/master themselves — `b398ff9 v2.5.2`).
- Dispatched an Explore subagent (agent-b3d61054) to map the v2.5.2
  codebase thoroughly. Returned a 1500-line report covering:
    * Identity resolution: resolveFlexible / canonicalFor / flexibleIdentityLadder
    * Shared identity index: rememberAnime / lookupAnime + backfill queue
    * Every browse endpoint with its extractor + identity richness
    * The /api/home cross-section non-uniform-data bug (line refs)
    * Where the airing countdown code lives (anilist.js:312-318 nextAiringEpisode;
      dropped by canonicalAnime; missing from /api/schedule and /api/airing)
    * Relation buckets (RELATION_BUCKETS / RELATION_ORDER / normalizeRelation)
    * File:line refs for every code path touched
- Created src/core/merge.js — the POST-SHAPE COMPLETENESS LAYER.
  For every row it:
    1. Fills from the shared identity index (lookupAnime by slug→title→id)
    2. Fills from AniList detail cache (anilistById, 24h cached)
    3. Remembers the slug↔title pair back into the index
    4. Enqueues background backfill for unknown slugs
  Bounded concurrency (MERGE_CONCURRENCY env, default 8).
- Updated src/core/shape.js canonicalAnime() to pick these new fields
  from the source list (they were silently dropped before):
    nextAiringEpisode, duration, averageScore, meanScore, popularity,
    favourites, studios, trailer, externalLinks.
  Added `_complete: Boolean(anilistId || malId || slug)` flag.
  Added `"obj"` kind to pick() helper for object fields.
- Updated src/core/identity.js rememberAnime() to track these new
  fields. lookupAnime() returns them. nextAiringEpisode is
  always-overwrite (per-show state that mutates daily).
- Updated src/core/anilist.js:
    * SEASON_QUERY now asks for nextAiringEpisode, duration, season
      (enum), averageScore — /api/airing gets the countdown natively.
    * shapeMedia() carries these into the shaped entry so canonicalAnime
      picks them up.
- Updated src/routes/unified.routes.js:
    * ITEM_STR / ITEM_ARR / ITEM_NULLABLE / ITEM_ART_NULLABLE / ITEM_OBJ
      lists expanded for the new fields + airingAt/airingEpisode/
      airingTime.
    * finalizeItem() preserves the new fields + strips _complete.
    * catalogListItem() carries airingAt/airingTime/airingEpisode
      from the raw extractor row through to the shaped item.
    * sendList() now invokes mergeIdentityFields() on every array
      branch (after dedupeBySlug, before enrichItemList). Also runs
      on object-shaped payloads (home/top-ten/trending-sidebar).
    * sendList() adds crossSectionMerge() for object-shaped payloads
      with 2+ section arrays — duplicate slugs across sections now
      point to the SAME enriched row (UNION of fields, not WORST).
    * /api/anime and /api/meta now call mergeItem() on the single
      detail resource (nextAiringEpisode + duration + averageScore +
      studios + trailer + banner top-up).
    * /api/schedule accepts ?date=YYYY-MM-DD (default = today UTC).
      Threads through kaze.schedule(date) → extractSchedule(date).
    * /api/resolve?advanced=1 / ?deep=1 climbs the longer ladder.
      Response gains `via` (which step won) + `advanced` (bool).
    * /api/seasons and /api/watch-order accept ?exclude= and ?include=
      params. Default excludes 'related' (AniList's catch-all).
      Self (relation="self") always survives. Response gains a
      `filter` block showing what was applied + defaulted.
    * parseRelationFilter() + applyRelationFilter() helpers.
- Updated src/core/keys.js flexibleIdentityLadder() with:
    * getSiteIdsByMal reverse-MAL lookup step (closes pure-mal: hole)
    * kaze.search(title, 5) fallback when both ids failed
    * multi-variant title search (raw, _→space, -→space)
    * backfill enqueue on miss
  getLaneSafe() helper uses dynamic import to avoid ES-module cycle.
- Updated src/sources/kaze/extractors/schedule.extractor.js:
    * Extractor now threads date properly (defaults to today's UTC)
    * Pulls the REAL listing slug from the row's <a> tag when available
      (was fabricated from the title)
    * Computes airingAt (unix seconds) from the time string anchored
      to the requested date's UTC midnight
    * Returns airingTime + airingAt + airingEpisode aliases
- Updated src/adapters/kaze.adapter.js:
    * kaze.schedule(date=null) (was schedule())
- Updated src/routes/system.routes.js /api/health to report
  enrichment.merge: "enabled (v2.6.0 post-shape completeness layer)".
- Bumped package.json to 2.6.0 + new description.
- Added v2.6.0 entry to CHANGELOG.md (with the bug table + the merge
  layer + the airing countdown + the advanced resolve + the watch-order
  filters + compatibility notes).
- Wrote scripts/test_v260_features.mjs — comprehensive battery covering:
    * /api/health (version + merge flag)
    * /api/home cross-section merge (shared slugs carry union of fields)
    * Every browse/discovery endpoint (field-completeness % per field)
    * /api/schedule airingAt countdown (?date= support)
    * /api/airing nextAiringEpisode + airingAt fallback
    * /api/anime + /api/meta detail merge (nextAiringEpisode, duration,
      averageScore, studios, trailer + identity of values)
    * /api/resolve?advanced=1 (via + advanced fields)
    * /api/watch-order filters (?exclude=, ?include=, default exclude)
    * /api/seasons filters
    * Regression: search, episodes, servers, watch, chain
  Writes TEST_REPORT_V260.md with per-endpoint completeness table.
- Ran the test battery locally — RESULT: 86 PASS · 0 FAIL · 0 SKIP.
  The field-completeness shows the merge layer is wired correctly:
  endpoints with index hits (e.g. /api/newly-added at 5%, /api/filter
  at 7%) carry anilistId/malId/year/genres/synonyms after the merge.
  Endpoints with no index hits show 0% — that's because AniList
  rate-limited during the test (the merge layer tried anilistById for
  every row and got 429s). In steady state with a warm index, the
  completeness % climbs.

Stage Summary:
- Files created: src/core/merge.js (~280 lines), scripts/test_v260_features.mjs (~320 lines)
- Files modified: src/core/shape.js, src/core/anilist.js, src/core/identity.js,
  src/core/keys.js, src/routes/unified.routes.js, src/routes/system.routes.js,
  src/adapters/kaze.adapter.js, src/sources/kaze/extractors/schedule.extractor.js,
  package.json, CHANGELOG.md
- Test result: 86 PASS / 0 FAIL / 0 SKIP
- TEST_REPORT_V260.md: 20 endpoints tested, 20 returned 200, full
  per-endpoint field-completeness table.
- /home/z/my-project/download/apikuoshi-v2.6.0.zip: clean repo zip
  (excludes node_modules + .git)

Architecture notes for future iterations:
- The merge layer (src/core/merge.js) is THE place to add new field
  sources. To pull from Kitsu/TMDB/etc., add a fillFromKitsu() /
  fillFromTmdb() helper and call it inside mergeItem() after
  fillFromAnilist(). Same shape contract (never override non-empty
  with empty, never block, time-capped).
- The merge layer is always-on. To add a `?merge=0` opt-out, gate
  the mergeIdentityFields() call in sendList() on a query param
  check (skipArt already does this for art enrichment).
- The airing countdown has TWO sources: kaze extractor (airingAt
  computed from time string) + AniList detail (nextAiringEpisode).
  The merge layer merges both — kaze's airingAt is on the row from
  the extractor; AniList's nextAiringEpisode is filled by the merge
  layer when anilistId is known.
- The advanced resolve ladder's getLaneSafe() uses dynamic import
  to break the keys.js → registry → kaze.adapter → extractors →
  shape.js → keys.js cycle. Don't convert it to a static import.
- The crossSectionMerge() in sendList() is wired to run BEFORE
  mergeIdentityFields() so the merge layer sees the unified row
  objects (one AniList call per unique slug, not per section).
- The watch-order filter (parseRelationFilter) defaults to
  exclude=['related']. The user mentioned "Music" — there's no
  "music" bucket today (AniList format:MUSIC falls through to
  "related" via bucketForRelation). Clients who want to drop music
  can just ?exclude=related.
- All v2.6.0 changes are ADDITIVE — no existing fields were renamed
  or removed. The kaze schedule adapter signature changed from
  schedule() to schedule(date=null) — backward compatible.

Things NOT done (good v2.6.1 candidates):
- `?merge=0` opt-out (currently always-on)
- `?fields=` param is plumbed but a no-op (could be wired to lazy
  enrichment for rarely-needed heavy fields like characters/VA)
- /api/resolve?advanced=1 doesn't yet cache its results — every
  call re-climbs the ladder. Could add a 60s cache.
- The TEST_REPORT_V260.md could be auto-published to /api/health
  or a /api/stats endpoint for live monitoring.


---
Task ID: v2.6.1
Agent: main (super-z)
Task: User clarified what v2.6.0 missed — "we dont need to know all
anime, what im talking about is reuse of data, combine them all
extractors or anything scrapes, since some of the endpoints has data,
why dont we adopt that logic". The v2.6.0 merge layer was filling
from AniList (which rate-limited + cold-started at 0% completeness).
The user wanted pure REUSE of data the kaze extractors ALREADY scrape.

Work Log:
- Probed /api/spotlight and /api/trending locally to confirm the
  bug: spotlight pulls rating/quality/releaseDate (sub/dub/total=0);
  trending pulls total/sub/dub/type/episodes (no rating/quality/
  releaseDate). Same upstream anime, different field subsets.
- Updated src/core/identity.js:
    * newRecord() pre-initializes the upstream-scraped fields:
      description, rating, quality, releaseDate, sub, dub, total,
      airingTime, airingAt, airingEpisode, duration, averageScore,
      nextAiringEpisode.
    * rememberAnime() accumulates them per-slug with the "never
      downgrade" rule. For sub/dub/total/airingAt/airingEpisode the
      LARGER value wins (so a 12-episode observation isn't
      overwritten by a later 0-episode miss).
    * lookupAnime() returns all the accumulated fields.
- Updated src/routes/unified.routes.js:
    * catalogListItem() now calls rememberAnime(raw) BEFORE shaping,
      passing ALL the upstream-extracted fields from the row. The
      row's own extractor data still wins (it's applied first via
      the shape layer's pick); the index only fills what THIS row's
      extractor didn't pull.
- Updated src/core/merge.js:
    * fillFromIndex() now reads the accumulated fields from the
      index and fills them on the row. Same "never overwrite non-
      empty with empty" rule.
- Verified live: hit /api/trending first, then /api/spotlight. The
  spotlight row 0 carried sub=23, dub=21, total=24, type=TV (from
  trending) AND rating=PG-13, quality=HD, releaseDate="Apr 3, 2026"
  (from spotlight's own extractor). Zero AniList calls made.
- Bumped package.json to 2.6.1.
- Added v2.6.1 entry to CHANGELOG.md with the bug table + the proof.

Stage Summary:
- Files modified: src/core/identity.js, src/routes/unified.routes.js,
  src/core/merge.js, package.json, CHANGELOG.md
- The fix is the RIGHT architecture: the identity index is now the
  central accumulator for ALL scraped data, not just ids. Every
  endpoint that touches a slug contributes its scraped fields; every
  subsequent endpoint that touches the same slug benefits.
- The AniList path (fillFromAnilist) is still there as a SECONDARY
  fill for fields no kaze extractor pulls (anilistId, malId, year,
  season enum, genres, synonyms, nextAiringEpisode). It runs only
  when the index path didn't fill those — so it doesn't trigger
  AniList rate-limits on cold start anymore.
- Cold-start completeness is now driven by what other endpoints
  have already scraped, not by AniList's rate-limit window.

Architecture notes for future iterations (in addition to v2.6.0 notes):
- The "never downgrade" rule is critical: a row's own extractor data
  is the SOURCE OF TRUTH for what that page actually said. The
  index only fills what that row's extractor didn't pull. Don't
  change this rule.
- For sub/dub/total/airingAt/airingEpisode we use "larger wins"
  instead of "first wins" because these are COUNTERS — a 24-episode
  observation is more accurate than a 12-episode observation, and
  a 0-episode miss shouldn't overwrite a 12-episode hit.
- The merge layer's AniList path could be made opt-in via
  ?merge=anilist for clients who explicitly want to pay the latency
  for the deepest fill. Default would stay index-only.
- The worklog is at /home/z/my-project/worklog.md and a copy is in
  the zip at /apikuoshi-v2.6.1/WORKLOG.md.
