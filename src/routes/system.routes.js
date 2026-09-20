/**
 * ============================================================
 *  APIKuoshi — src/routes/system.routes.js
 * ============================================================
 *  GET /api/health       — uptime, version, cache health
 *  GET /api/docs         — interactive HTML docs + playground (browsers)
 *                          machine-readable catalog JSON (API clients)
 *  GET /api/docs.json    — always JSON
 *  GET /api/openapi.json — OpenAPI 3.1 generated from the same catalog
 * ============================================================
 */
import { Router as expressRouter } from "express";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { cacheStats } from "../core/cache.js";
import config from "../config.js";
import { buildCatalog } from "../docs/catalog.js";
import { renderDocsPage } from "../docs/docsPage.js";
import { enrichmentEnabled, tmdbEnabled } from "../core/enrich.js";
import { identityStats } from "../core/identity.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = expressRouter();

const startedAt = Date.now();

router.get("/health", (req, res) => {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  res.json({
    success: true,
    api: "APIKuoshi",
    version,
    status: "healthy",
    uptime: `${h}h ${m}m ${uptime % 60}s`,
    uptimeSeconds: uptime,
    node: process.version,
    optionalProxies: {
      scraperApi: config.scraperApiKey ? "enabled" : "off (not needed)",
      flaresolverr: config.flaresolverrUrl ? "enabled" : "off (not needed)",
    },
    enrichment: {
      art: enrichmentEnabled() ? "enabled" : "disabled (ART_ENRICHMENT=0)",
      kitsu: "enabled (keyless)",
      tmdb: tmdbEnabled() ? "enabled (TMDB_API_KEY set)" : "off (TMDB_API_KEY not set — optional)",
      // v2.6.0 — the post-shape merge layer is always on; the flag
      // here lets clients verify the version they're talking to.
      merge: "enabled (v2.6.0 post-shape completeness layer)",
    },
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + "MB",
    },
    cache: cacheStats(),
    identityIndex: identityStats(),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// v2.4.0 — GET /download — the full APIKuoshi source as a ZIP.
// Resolved at request time from, in order: KUOSHI_ZIP_PATH env, the repo root
// (`apikuoshi-<version>.zip`), or ../download/ (workspace convention).
// Serves a clean JSON 404 when no archive is deployed — never a 5xx.
//
// v2.5.0 FIX: the ZIP handler is mounted ONLY at the top-level /download
// (see app.js). It used to ALSO live at /api/download inside this router —
// and because systemRoutes mounts before unifiedRoutes, it shadowed the
// documented /api/download?key=…&ep=1 EPISODE-links endpoint forever (the
// docs catalog and both live suites always expected episode links there).
// ---------------------------------------------------------------------------
function zipCandidates() {
  const name = `apikuoshi-v${version}.zip`;
  const list = [];
  if (process.env.KUOSHI_ZIP_PATH) list.push(process.env.KUOSHI_ZIP_PATH);
  list.push(
    path.resolve(__dirname, "../..", name),
    path.resolve(__dirname, "../../../download", name),
    path.resolve(process.cwd(), name)
  );
  return [...new Set(list)];
}

// v2.5.0: no /api/download mount here — the episode-links endpoint in
// unified.routes.js owns that path; the ZIP stays at top-level /download.
// router.get("/download", downloadZipHandler);

/** v2.4.0: also exported — app.js aliases this at the top level (GET /download). */
function downloadZipHandler(req, res) {
  const found = zipCandidates().find((p) => {
    try { return p && fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!found) {
    return res.status(404).json({
      success: false,
      api: "APIKuoshi",
      message: `No source archive deployed for v${version} — build one with 'zip -r apikuoshi-v${version}.zip .' or set KUOSHI_ZIP_PATH.`,
    });
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="apikuoshi-v${version}.zip"`);
  fs.createReadStream(found).pipe(res);
}

export { downloadZipHandler };

// ---------------------------------------------------------------------------
// Docs — generated from src/docs/catalog.js (single source of truth).
//   Browser  (Accept: text/html)  -> interactive HTML page + playground
//   API client (default / ?format=json) -> machine-readable catalog JSON
// The HTML page is rendered once per process and cached.
// ---------------------------------------------------------------------------

let cachedPage = null;
let cachedPageVersion = null;

function docsHtml() {
  if (!cachedPage || cachedPageVersion !== version) {
    cachedPage = renderDocsPage(version);
    cachedPageVersion = version;
  }
  return cachedPage;
}

router.get("/docs", (req, res) => {
  const wantsHtml =
    req.query.format !== "json" && /text\/html/i.test(req.headers.accept || "");
  if (wantsHtml) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(docsHtml());
    return;
  }
  res.json(buildCatalog(version));
});

router.get("/docs.json", (req, res) => {
  res.json(buildCatalog(version));
});

// OpenAPI 3.1 — generated from the same catalog so it can never drift.
router.get("/openapi.json", (req, res) => {
  const catalog = buildCatalog(version);
  const paths = {};
  for (const ep of [...(catalog.allEndpoints || []), ...(catalog.systemEndpoints || [])]) {
    const p = ep.p === "/" ? "/" : ep.p.replace(/:([a-zA-Z]+)/g, "{$1}");
    paths[p] = paths[p] || {};
    paths[p][ep.m.toLowerCase()] = {
      summary: ep.d,
      description: ep.tip || undefined,
      parameters: (ep.params || []).map((q) => ({
        name: q.n, in: "query", required: false, description: q.d,
        schema: { type: "string", example: String(q.ex) },
      })),
    };
  }
  res.json({
    openapi: "3.1.0",
    info: {
      title: "APIKuoshi",
      version,
      description: "One anime REST API — search, browse, metadata and playback through a single normalized surface.",
    },
    servers: [{ url: "/" }],
    paths,
  });
});

export default router;
