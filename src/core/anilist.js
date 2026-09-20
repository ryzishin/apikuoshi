/**
 * ============================================================
 *  APIKuoshi — src/core/anilist.js                    v2.2.0
 * ============================================================
 *  Canonical anime identity via AniList GraphQL (free, keyless).
 *  Used ONLY by the unified layer to anchor romaji/English titles
 *  to one canonical entry so dedup is reliable.
 *
 *  v2.2 CACHING RULE: AniList being down / rate-limited is an
 *  EXPECTED condition (shared egress IPs). A failed lookup used to
 *  be cached for the full 24 h TTL, poisoning every identity
 *  endpoint for a day. Now: successful results keep their long
 *  TTL; empty/failed results are cached for only ~45 s so recovery
 *  is fast. Implement with withCacheOk() below.
 *  ============================================================
 */
import axios from "axios";
import { withCache, cacheGet, cacheSet, dedup } from "./cache.js";
import { titleSlug } from "./shape.js";
import { rememberAnime } from "./identity.js";

/**
 * Cache-through helper for upstream lookups: caches GOOD results for
 * `ttlSeconds` and bad/empty results for only `emptyTtlSeconds`.
 * "Bad" = null, undefined, [] or an object with an empty results array.
 */
async function withCacheOk(key, ttlSeconds, fn, emptyTtlSeconds = 45) {
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  // v2.4.0: share ONE in-flight run across parallel callers (stampede guard)
  const value = await dedup(`run:${key}`, fn);
  const good =
    value !== null && value !== undefined &&
    !(Array.isArray(value) && value.length === 0) &&
    !(value && typeof value === "object" && Array.isArray(value.results) && value.results.length === 0);
  cacheSet(key, value, good ? ttlSeconds : emptyTtlSeconds);
  return value;
}

const CLIENT = axios.create({
  baseURL: "https://graphql.anilist.co",
  timeout: 12000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "APIKuoshi/1.0 (+unified dedup layer)",
  },
});

const SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
      id
      idMal
      title { romaji english native }
      synonyms
      episodes
      format
      status
      seasonYear
      coverImage { large medium }
      bannerImage
    }
  }
}`;

const BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title { romaji english native }
    synonyms
    episodes
    format
    status
    seasonYear
    genres
    coverImage { large medium }
    bannerImage
  }
}`;

const SEASON_QUERY = `
query ($season: MediaSeason, $year: Int) {
  Page(page: 1, perPage: 30) {
    media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      id
      idMal
      title { romaji english native }
      episodes
      duration
      format
      status
      season
      seasonYear
      averageScore
      coverImage { large medium }
      nextAiringEpisode { episode airingAt timeUntilAiring }
    }
  }
}`;

const RELATIONS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          idMal
          title { romaji english native }
          type
          format
          episodes
          status
          seasonYear
          coverImage { large medium }
        }
      }
    }
  }
}`;

const DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title { romaji english native }
    synonyms
    episodes
    duration
    format
    status
    season
    seasonYear
    averageScore
    meanScore
    popularity
    favourites
    genres
    description(asHtml: false)
    coverImage { large medium }
    bannerImage
    studios(isMain: true) { nodes { name } }
    trailer { id site }
    externalLinks { site url }
    nextAiringEpisode { episode airingAt timeUntilAiring }
  }
}`;

const CHARACTERS_QUERY = `
query ($id: Int, $perPage: Int) {
  Media(id: $id, type: ANIME) {
    characters(perPage: $perPage, sort: [ROLE, RELEVANCE]) {
      edges {
        role
        node { id name { full } image { large } }
        voiceActors(language: JAPANESE) { id name { full } image { large } }
      }
    }
  }
}`;

const RECOMMENDATIONS_QUERY = `
query ($id: Int, $perPage: Int) {
  Media(id: $id, type: ANIME) {
    recommendations(perPage: $perPage, sort: RATING_DESC) {
      nodes {
        rating
        mediaRecommendation {
          id
          idMal
          title { romaji english }
          coverImage { large }
          format
          episodes
          averageScore
        }
      }
    }
  }
}`;

function shapeMedia(m) {
  if (!m) return null;
  const title = m.title?.english || m.title?.romaji || null;
  const romaji = m.title?.romaji || null;
  const shaped = {
    anilistId: m.id,
    malId: m.idMal ?? null,
    // derived, deterministic address — listing slugs override it upstream
    slug: titleSlug(romaji || title || ""),
    title,
    titleRomaji: romaji,
    titleEnglish: m.title?.english || null,
    titleNative: m.title?.native || null,
    synonyms: m.synonyms || [],
    genres: m.genres || [],
    episodes: m.episodes ?? null,
    format: m.format || null,
    status: m.status || null,
    season: m.season || null,            // v2.6.0 — AniList enum (WINTER/SPRING/SUMMER/FALL)
    year: m.seasonYear ?? null,
    duration: m.duration ?? null,        // v2.6.0 — per-episode minutes
    averageScore: m.averageScore ?? null,
    poster: m.coverImage?.large || m.coverImage?.medium || null,
    banner: m.bannerImage || null,
    // v2.6.0 — the schedule/airing countdown. The SEASON_QUERY now
    // asks for nextAiringEpisode; shapeMedia carries it through so
    // the merge layer + canonicalAnime pick it up.
    nextAiringEpisode: m.nextAiringEpisode ? {
      episode: m.nextAiringEpisode.episode,
      airingAt: m.nextAiringEpisode.airingAt,
      countdownSeconds: m.nextAiringEpisode.timeUntilAiring,
    } : null,
  };
  // v2.4.0: every AniList-shaped entry feeds the shared identity index —
  // this is how browse rows learn the ids another endpoint resolved.
  if (shaped.anilistId || shaped.malId) rememberAnime(shaped);
  return shaped;
}

/** Search AniList for canonical matches (24h cache; misses only 45s). */
export async function anilistSearch(query, perPage = 8) {
  if (!query) return [];
  return withCacheOk(`al:search:${query.toLowerCase()}:${perPage}`, 86400, async () => {
    try {
      const res = await CLIENT.post("", {
        query: SEARCH_QUERY,
        variables: { search: query, perPage },
      });
      const list = res.data?.data?.Page?.media ?? [];
      return list.map(shapeMedia).filter(Boolean);
    } catch (err) {
      console.error("[APIKUOSHI][anilist] search failed:", err.message);
      return [];
    }
  });
}

/** Fetch one canonical entry by AniList id (24h cache; failures only 45s).
 *  v2.4.0: one steady retry — a transient 429/timeout on the shared egress
 *  IP used to surface as a 500/502 on /api/anime and /api/resolve. */
export async function anilistById(anilistId) {
  const run = () => withCacheOk(`al:id:${anilistId}`, 86400, async () => {
    try {
      const res = await CLIENT.post("", {
        query: BY_ID_QUERY,
        variables: { id: parseInt(anilistId, 10) },
      });
      return shapeMedia(res.data?.data?.Media);
    } catch (err) {
      console.error("[APIKUOSHI][anilist] byId failed:", err.message);
      return null;
    }
  });
  const first = await run();
  if (first) return first;
  await new Promise((r) => setTimeout(r, 400));
  // second miss inside the 45s negative-cache window — force one live retry
  try {
    const res = await CLIENT.post("", {
      query: BY_ID_QUERY,
      variables: { id: parseInt(anilistId, 10) },
    });
    const shaped = shapeMedia(res.data?.data?.Media);
    if (shaped) cacheSet(`al:id:${anilistId}`, shaped, 86400);
    return shaped;
  } catch {
    return null;
  }
}

/** Currently airing this season (1h cache) — used by /api/airing. */
export async function anilistAiringSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const season =
    month <= 3 ? "WINTER" : month <= 6 ? "SPRING" : month <= 9 ? "SUMMER" : "FALL";
  const year = now.getFullYear();
  return withCacheOk(`al:season:${season}:${year}`, 3600, async () => {
    try {
      const res = await CLIENT.post("", {
        query: SEASON_QUERY,
        variables: { season, year },
      });
      const list = res.data?.data?.Page?.media ?? [];
      return list.map(shapeMedia).filter(Boolean);
    } catch (err) {
      console.error("[APIKUOSHI][anilist] season failed:", err.message);
      return [];
    }
  });
}

/**
 * Rich canonical metadata, straight from AniList.
 * Used by GET /api/meta — the
 * unified surface without touching its engine files.
 */
export async function anilistDetail(anilistId) {
  return withCacheOk(`al:detail:${anilistId}`, 21600, async () => {
    try {
      const res = await CLIENT.post("", {
        query: DETAIL_QUERY,
        variables: { id: parseInt(anilistId, 10) },
      });
      const m = res.data?.data?.Media;
      if (!m) return null;
      return {
        ...shapeMedia(m),
        season: m.season || null,
        duration: m.duration ?? null,
        averageScore: m.averageScore ?? null,
        meanScore: m.meanScore ?? null,
        popularity: m.popularity ?? null,
        favourites: m.favourites ?? null,
        genres: m.genres || [],
        synopsis: m.description || null,
        studios: (m.studios?.nodes || []).map((s) => s.name),
        trailer: m.trailer ? { id: m.trailer.id, site: m.trailer.site } : null,
        externalLinks: m.externalLinks || [],
        nextAiringEpisode: m.nextAiringEpisode
          ? {
              episode: m.nextAiringEpisode.episode,
              airingAt: m.nextAiringEpisode.airingAt,
              countdownSeconds: m.nextAiringEpisode.timeUntilAiring,
            }
          : null,
      };
    } catch (err) {
      console.error("[APIKUOSHI][anilist] detail failed:", err.message);
      return null;
    }
  });
}

/** Characters + JP voice actors (6h cache). Used by GET /api/meta/characters. */
export async function anilistCharacters(anilistId, perPage = 24) {
  return withCacheOk(`al:chars:${anilistId}:${perPage}`, 21600, async () => {
    try {
      const res = await CLIENT.post("", {
        query: CHARACTERS_QUERY,
        variables: { id: parseInt(anilistId, 10), perPage },
      });
      const edges = res.data?.data?.Media?.characters?.edges ?? [];
      return edges.map((e) => ({
        role: e.role || null,
        character: {
          id: e.node?.id ?? null,
          name: e.node?.name?.full || null,
          image: e.node?.image?.large || null,
        },
        voiceActor: e.voiceActors?.[0]
          ? { id: e.voiceActors[0].id, name: e.voiceActors[0].name?.full, image: e.voiceActors[0].image?.large }
          : null,
      }));
    } catch (err) {
      console.error("[APIKUOSHI][anilist] characters failed:", err.message);
      return [];
    }
  });
}

/** Top recommendations (6h cache). Used by GET /api/meta/recommendations. */
export async function anilistRecommendations(anilistId, perPage = 12) {
  return withCacheOk(`al:recs:${anilistId}:${perPage}`, 21600, async () => {
    try {
      const res = await CLIENT.post("", {
        query: RECOMMENDATIONS_QUERY,
        variables: { id: parseInt(anilistId, 10), perPage },
      });
      const nodes = res.data?.data?.Media?.recommendations?.nodes ?? [];
      return nodes
        .filter((n) => n.mediaRecommendation)
        .map((n) => ({
          rating: n.rating ?? null,
          anilistId: n.mediaRecommendation.id,
          malId: n.mediaRecommendation.idMal ?? null,
          title: n.mediaRecommendation.title?.english || n.mediaRecommendation.title?.romaji || null,
          titleRomaji: n.mediaRecommendation.title?.romaji || null,
          poster: n.mediaRecommendation.coverImage?.large || null,
          format: n.mediaRecommendation.format || null,
          episodes: n.mediaRecommendation.episodes ?? null,
          averageScore: n.mediaRecommendation.averageScore ?? null,
        }));
    } catch (err) {
      console.error("[APIKUOSHI][anilist] recommendations failed:", err.message);
      return [];
    }
  });
}

/**
 * Related media (relations graph) — prequel/sequel/specials/ova/ona/movie/
 * side story/alternative/summary/source. Used by GET /api/meta and
 * GET /api/anime detail payloads for the seasons/specials blocks.
 */
export async function anilistRelations(anilistId) {
  return withCacheOk(`al:rel:${anilistId}`, 21600, async () => {
    try {
      const res = await CLIENT.post("", {
        query: RELATIONS_QUERY,
        variables: { id: parseInt(anilistId, 10) },
      });
      const edges = res.data?.data?.Media?.relations?.edges ?? [];
      return edges
        .filter((e) => e.node && e.node.type === "ANIME")
        .map((e) => {
          const shaped = shapeMedia(e.node);
          return {
            relationType: e.relationType || null,
            ...shaped,
          };
        });
    } catch (err) {
      console.error("[APIKUOSHI][anilist] relations failed:", err.message);
      return [];
    }
  }, 60);
}

/**
 * v2.5.2 — Build the COMPLETE franchise relation set for one anime by
 * walking AniList's relations graph TRANSITIVELY and BIDIRECTIONALLY.
 *
 * THE BUG THIS FIXES:
 * AniList only stores DIRECT relation edges on each entry — "Steins;Gate
 * → SEQUEL → Steins;Gate 0" lives on the SG record, NOT on the SG0
 * record. So a single `anilistRelations(sg0Id)` call returns SG0's own
 * edges (the 23β OVA, the Valentine OVA) but MISSES the original SG —
 * which IS SG0's prequel, just stored on the SG side. /api/watch-order
 * therefore returned a truncated franchise for any sequel/season-N
 * caller. Mushoku Tensei S3 (178789) returned 1 entry (S2P2 only);
 * SG0 returned 2 entries (the OVAs only); the parent show was missing
 * in both. The user-visible symptom: "even if I call using season 3 of
 * anime it shows its watch order saying its a prequel or sequel" — i.e.
 * the immediate-neighbor labels were returned, but the rest of the
 * franchise (the actual watch ORDER) was not.
 *
 * STRATEGY:
 *   BFS from root, up to `maxDepth` hops, gathering every ANIME-type
 *   neighbor. Each hop fetches that node's anilistRelations (cached 6h,
 *   so steady-state is one call per franchise member). Each discovered
 *   node is labeled with its relation to ROOT:
 *     - root's direct edge label, when root itself has an edge to it
 *     - "PREQUEL" when discovered by walking only PREQUEL/PARENT edges
 *     - "SEQUEL" when discovered by walking only SEQUEL edges
 *     - the immediate edge type otherwise (SIDE_STORY, SPIN_OFF, …)
 *
 * RETURNS:
 *   { root: <shaped root media>, entries: [<shaped media + relationType
 *   + franchiseHops>, ...] }  — entries EXCLUDES the root itself; the
 *   caller decides whether to splice root back in (watch-order does,
 *   seasons does not). The cache TTL mirrors anilistRelations (6h good,
 *   ~60s empty) so the same franchise walk is shared by every caller
 *   for the same root id.
 *
 * Bounded by `maxDepth` (default 3) and `maxNodes` (default 40) so a
 * pathological graph cannot runaway; franchises are typically <10 nodes.
 */
const FRANCHISE_BACKWARD_EDGES = new Set(["PREQUEL", "PARENT"]);
const FRANCHISE_FORWARD_EDGES = new Set(["SEQUEL"]);

/**
 * v2.7.0 — Relation types EXCLUDED from the franchise transitive walk.
 * AniList's CHARACTER relation is almost always a crossover collab
 * (e.g. Chiyuki no Fashion Check has a CHARACTER edge to AOT but is
 * NOT part of the AOT franchise). OTHER is also typically crossover
 * noise. SOURCE is the manga/light novel the anime adapts. COMPILATION
 * is a recap clip-show. These edges, when walked transitively, pull in
 * unrelated anime and pollute the franchise graph (AOT was showing
 * Anime-Gataris as a sequel; Steins;Gate was showing Madoka Magica).
 */
const FRANCHISE_EXCLUDED_EDGES = new Set([
  "CHARACTER",
  "OTHER",
  "SOURCE",
  "COMPILATION",
]);

export async function anilistFranchise(rootAnilistId, options = {}) {
  // maxDepth=4 covers franchises up to 4 hops from root — verified
  // necessary for Mushoku Tensei (S3 → S2P2 → S2 → Cour2 → S1 is a
  // 4-hop prequel chain) and similar long-seasonal franchises. Going
  // deeper would risk walking into adjacent franchises via shared
  // studio/source/character edges (which AniList sometimes labels
  // OTHER or CHARACTER); depth 4 is the empirical sweet spot.
  // v2.7.0: depth alone wasn't enough — we now also EXCLUDE
  // CHARACTER/OTHER/SOURCE/COMPILATION edges entirely, so crossover
  // collabs never enter the graph no matter how deep we walk.
  const maxDepth = options.maxDepth ?? 4;
  const maxNodes = options.maxNodes ?? 40;
  const cacheKey = `al:franchise:${rootAnilistId}:d${maxDepth}:n${maxNodes}:v7`;

  return withCacheOk(cacheKey, 21600, async () => {
    const rootId = parseInt(rootAnilistId, 10);
    if (!Number.isFinite(rootId)) return { root: null, entries: [] };

    const rootShaped = await anilistById(rootId);
    if (!rootShaped) return { root: null, entries: [] };

    // Direct edges from root, looked up by neighbor anilistId — used to
    // pick the correct label (from root's perspective) for any node root
    // has a direct edge to, regardless of how we walked to it.
    const rootDirect = await anilistRelations(rootId).catch(() => []);
    const directEdgeByNeighbor = new Map();
    for (const r of rootDirect) {
      if (r?.anilistId) directEdgeByNeighbor.set(r.anilistId, r.relationType || "OTHER");
    }

    // BFS state.
    const discovered = new Map(); // anilistId -> { shaped, hops, dir, edgeType }
    discovered.set(rootId, { shaped: rootShaped, hops: 0, dir: "self", edgeType: "self" });
    const visited = new Set([rootId]);
    let queue = [{ id: rootId, hops: 0, dir: "self" }];

    while (queue.length && discovered.size < maxNodes) {
      // Gather one full BFS level in parallel — keeps the walk under
      // a few hundred ms in steady state (each node's relations are
      // already cached after the first caller walked them). Bound the
      // batch so a wide level never spawns dozens of concurrent calls.
      const level = queue.slice(0, 8);
      queue = queue.slice(8);
      const expanded = await Promise.all(level.map(async (cur) => {
        if (cur.hops >= maxDepth) return [];
        const rels = await anilistRelations(cur.id).catch(() => []);
        const out = [];
        for (const r of rels) {
          if (!r?.anilistId) continue;
          // v2.7.0: EXCLUDE crossover-collab edges (CHARACTER/OTHER/
          // SOURCE/COMPILATION) so the franchise graph stays clean.
          // Without this filter, AOT's CHARACTER edge to "Chiyuki no
          // Fashion Check" pulls in the entire Anime-Gataris spin-off
          // tree as false sequels.
          const edgeType = (r.relationType || "OTHER").toUpperCase();
          if (FRANCHISE_EXCLUDED_EDGES.has(edgeType)) continue;
          if (discovered.size + out.length >= maxNodes) break;
          out.push({ cur, r });
        }
        return out;
      }));
      const nextLevel = [];
      for (const pairs of expanded) {
        for (const { cur, r } of pairs) {
          const nid = r.anilistId;
          if (visited.has(nid)) continue;
          visited.add(nid);
          if (discovered.size >= maxNodes) break;

          const edgeType = (r.relationType || "OTHER").toUpperCase();
          const isBack = FRANCHISE_BACKWARD_EDGES.has(edgeType);
          const isFwd = FRANCHISE_FORWARD_EDGES.has(edgeType);

          // Extend the BFS path direction. "self" is the root; once we
          // step off onto a backward/forward/side track we stay on it
          // unless the edge type changes — then we collapse to "side"
          // (the relation is no longer a clean prequel/sequel chain).
          let nextDir;
          if (cur.dir === "self") {
            nextDir = isBack ? "backward" : isFwd ? "forward" : "side";
          } else if (cur.dir === "backward") {
            nextDir = isBack ? "backward" : "side";
          } else if (cur.dir === "forward") {
            nextDir = isFwd ? "forward" : "side";
          } else {
            nextDir = "side";
          }

          discovered.set(nid, {
            shaped: r,
            hops: cur.hops + 1,
            dir: nextDir,
            edgeType,
          });
          nextLevel.push({ id: nid, hops: cur.hops + 1, dir: nextDir });
        }
        if (discovered.size >= maxNodes) break;
      }
      queue = nextLevel;
    }

    // Build the entries list — root excluded; each entry labeled with
    // its relation to ROOT (direct edge wins; transitive inference
    // fills the rest based on the path direction).
    //
    // AMBIGUOUS-EDGE FALLBACK: relation types like ALTERNATIVE / SIDE_STORY
    // are bidirectional in AniList ("X is alternative to Y" is the same
    // statement as "Y is alternative to X") so the path-direction inference
    // alone can't tell us whether the discovered node sits BEFORE or AFTER
    // root in story. When such an edge is reached via a BACKWARD chain
    // (we were already walking prequels/parents) we use the release year
    // as the tie-breaker: an older node is a PREQUEL of root, a newer
    // node is a SEQUEL. Direct root edges keep their actual label.
    const rootYear = rootShaped?.year ?? null;
    const entries = [];
    for (const [id, info] of discovered) {
      if (id === rootId) continue;
      let relFromRoot;
      if (directEdgeByNeighbor.has(id)) {
        relFromRoot = directEdgeByNeighbor.get(id);
      } else if (info.dir === "backward") {
        relFromRoot = "PREQUEL";
      } else if (info.dir === "forward") {
        relFromRoot = "SEQUEL";
      } else {
        // Side chain — the immediate edge type from the predecessor
        // describes the relation between predecessor and this node, NOT
        // between root and this node. When the edge type is one of the
        // bidirectional/ambiguous kinds, prefer a release-year-aware
        // prequel/sequel label from root's perspective.
        const ambiguous = ["ALTERNATIVE", "SIDE_STORY", "SPIN_OFF",
          "SUMMARY", "COMPILATION", "CONTAINS", "OTHER", "CHARACTER"];
        const y = info.shaped?.year ?? null;
        if (ambiguous.includes(info.edgeType) &&
            Number.isFinite(rootYear) && Number.isFinite(y)) {
          relFromRoot = y < rootYear ? "PREQUEL" : (y > rootYear ? "SEQUEL" : info.edgeType);
        } else {
          relFromRoot = info.edgeType;
        }
      }
      entries.push({
        ...info.shaped,
        relationType: relFromRoot,
        franchiseHops: info.hops,
      });
    }

    return { root: rootShaped, entries };
  }, 60);
}

/** Seasonal anime grid. Used by GET /api/meta/season?season=&year=. */
const SEASON_PAGED_QUERY = `
query ($season: MediaSeason, $year: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      id
      idMal
      title { romaji english native }
      synonyms
      episodes
      format
      status
      seasonYear
      coverImage { large medium }
    }
  }
}`;

export async function anilistSeason(season, year, page = 1) {
  const perPage = 30;
  const run = () => withCacheOk(`al:season:${season}:${year}:${page}`, 10800, async () => {
    try {
      const res = await CLIENT.post("", {
        query: SEASON_PAGED_QUERY,
        variables: { season, year, page, perPage },
      });
      const pg = res.data?.data?.Page;
      const list = pg?.media ?? [];
      return {
        pageInfo: pg?.pageInfo || null,
        results: list.map(shapeMedia).filter(Boolean),
      };
    } catch (err) {
      console.error("[APIKUOSHI][anilist] season failed:", err.message);
      return { pageInfo: null, results: [] };
    }
  });
  // v2.4.0: one steady retry so a transient AniList failure cannot hollow
  // out the seasonal grid (empty results stay cached only 45 s).
  const first = await run();
  if (first?.results?.length) return first;
  await new Promise((r) => setTimeout(r, 400));
  const second = await run();
  if (second?.results?.length) return second;
  try {
    const res = await CLIENT.post("", {
      query: SEASON_PAGED_QUERY,
      variables: { season, year, page, perPage },
    });
    const pg = res.data?.data?.Page;
    const list = pg?.media ?? [];
    const out = { pageInfo: pg?.pageInfo || null, results: list.map(shapeMedia).filter(Boolean) };
    if (out.results.length) cacheSet(`al:season:${season}:${year}:${page}`, out, 10800);
    return out;
  } catch {
    return first;
  }
}
