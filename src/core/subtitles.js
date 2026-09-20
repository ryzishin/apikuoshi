/**
 * ============================================================
 *  APIKuoshi — src/core/subtitles.js                 v2.5.0
 * ============================================================
 *  Subtitle format utilities for /api/proxy/subtitle.
 *
 *  Upstream subtitle tracks arrive as WebVTT (.vtt — the megaplay
 *  /videojs/ pipeline), SRT (the legacy getSources lane), or
 *  occasionally ASS/SSA. Browsers only render VTT natively, while
 *  plenty of clients (video players, download pipelines) still
 *  prefer SRT — so the proxy now converts between the two formats
 *  instead of blindly echoing bytes.
 *
 *  Public API:
 *    detectSubtitleFormat(text)  -> "vtt" | "srt" | "ass" | "unknown"
 *    srtToVtt(text)              -> WebVTT string
 *    vttToSrt(text)              -> SRT string
 *    convertSubtitle(text, to)   -> { text, format } converted content
 *
 *  Design rules:
 *    - Content-sniffing first, filename second: CDNs disguise
 *      payloads (segments as .jpg, playlists as .txt) and subtitle
 *      endpoints are no different — the bytes decide the format.
 *    - Never throw on weird input: conversion is best-effort, the
 *      original text is the fallback, and malformed cues are kept
 *      as-is rather than dropping dialogue.
 *    - No dependencies, pure string transforms.
 * ============================================================
 */

// ---------------------------------------------------------------- detect

/**
 * Sniff the subtitle format from the payload itself.
 * @param {string} text - raw subtitle payload
 * @returns {"vtt"|"srt"|"ass"|"unknown"}
 */
export function detectSubtitleFormat(text = "") {
  const s = String(text || "");
  if (!s.trim()) return "unknown";
  // WebVTT: mandatory WEBVTT magic on the first line (BOM tolerated)
  if (/^\uFEFF?WEBVTT/i.test(s)) return "vtt";
  // ASS/SSA: [Script Info] section header
  if (/^\s*\[Script Info\]/i.test(s) || /^\s*\[V4\+ Styles\]/im.test(s)) return "ass";
  // SRT: one or more "NN --> NN" time arrows with COMMA millis.
  // (VTT uses dot millis, so a comma arrow is a strong SRT signal.)
  // Look at the first time arrow found anywhere in the body.
  const arrow = s.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/);
  if (arrow) return arrow[1].includes(",") ? "srt" : "vtt";
  return "unknown";
}

// ---------------------------------------------------------------- helpers

/** Normalize an hours-minutes-millis timestamp to "HH:MM:SS.mmm". */
function toVttTime(stamp = "") {
  const m = String(stamp).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = m[4].padEnd(3, "0").slice(0, 3);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${ms}`;
}

/** Normalize a timestamp to SRT's "HH:MM:SS,mmm". */
function toSrtTime(stamp = "") {
  const vtt = toVttTime(stamp);
  return vtt ? vtt.replace(".", ",") : null;
}

// ---------------------------------------------------------------- SRT → VTT

/**
 * Convert SubRip (SRT) to WebVTT.
 * - Prepends the WEBVTT header (plus a kind note)
 * - Rewrites "00:00:01,000 -->" to "00:00:01.000 -->"
 * - Keeps cue text (including HTML-ish tags) byte-for-byte
 * - Drops SRT counter lines (VTT cues are unnamed; numbering is
 *   re-created on the SRT side by vttToSrt)
 * @param {string} srt
 * @returns {string} WebVTT payload
 */
export function srtToVtt(srt = "") {
  const src = String(srt || "").replace(/^\uFEFF/, "");
  if (!src.trim()) return "WEBVTT\n";
  // already VTT? return as-is (idempotent safety for callers)
  if (/^WEBVTT/i.test(src)) return src;

  const blocks = src.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const out = ["WEBVTT", ""];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    // find the timing line (may be first line, or after a counter)
    const tIdx = lines.findIndex((l) => /-->/.test(l));
    if (tIdx === -1) {
      // header junk (e.g. "1" followed by nothing) or metadata — skip pure counters
      if (!/^\d+$/.test(lines[0].trim())) out.push(...lines, "");
      continue;
    }
    const [start, ...rest] = lines[tIdx].split("-->");
    const end = rest.join("-->");
    const s = toVttTime(start);
    const e = toVttTime(end);
    if (!s || !e) {
      // unparseable timing — keep the cue untouched rather than lose dialogue
      out.push(...lines, "");
      continue;
    }
    out.push(`${s} --> ${e}`, ...lines.slice(tIdx + 1), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------- VTT → SRT

/**
 * Convert WebVTT to SubRip (SRT).
 * - Strips WEBVTT/NOTE/STYLE/REGION blocks and cue settings
 * - Rewrites "00:00:01.000 -->" to "00:00:01,000 -->"
 * - Re-numbers cues 1..N (SRT counters are mandatory)
 * - Keeps voice/text tags; SRT players tolerate <b>/<i>
 * @param {string} vtt
 * @returns {string} SRT payload
 */
export function vttToSrt(vtt = "") {
  const src = String(vtt || "").replace(/^\uFEFF/, "");
  if (!src.trim()) return "";
  const blocks = src.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = [];
  let counter = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    const first = lines[0].trim();
    // strip header/metadata blocks
    if (/^WEBVTT/i.test(first)) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(first)) continue;
    // find the timing line (VTT cues may carry an id line before it)
    const tIdx = lines.findIndex((l) => /-->/.test(l));
    if (tIdx === -1) continue;
    const [rawStart, ...rest] = lines[tIdx].split("-->");
    const rawEnd = rest.join("-->");
    const s = toSrtTime(rawStart);
    // drop VTT cue settings (position/align/line) from the end stamp
    const e = toSrtTime(String(rawEnd).trim().split(/\s+/)[0]);
    if (!s || !e) continue;
    const text = lines.slice(tIdx + 1);
    if (!text.length) continue;
    counter++;
    cues.push([String(counter), `${s} --> ${e}`, ...text].join("\n"));
  }
  return cues.join("\n\n") + (cues.length ? "\n" : "");
}

// ---------------------------------------------------------------- gateway

/**
 * Convert a subtitle payload to the requested target format.
 * Unknown sources are passed through untouched (with format "unknown")
 * so ASS/SSA and exotic payloads never get corrupted by a bad guess.
 *
 * @param {string} text       raw payload
 * @param {"vtt"|"srt"} to    requested target format
 * @returns {{ text: string, format: "vtt"|"srt"|"ass"|"unknown", converted: boolean }}
 */
export function convertSubtitle(text = "", to = "vtt") {
  const source = detectSubtitleFormat(text);
  const target = String(to || "vtt").toLowerCase() === "srt" ? "srt" : "vtt";
  if (source === target) return { text: String(text || ""), format: source, converted: false };
  if (target === "srt") {
    if (source === "vtt") return { text: vttToSrt(text), format: "srt", converted: true };
    // ass/srt-ish/unknown → hand back untouched (never corrupt)
    return { text: String(text || ""), format: source, converted: false };
  }
  // target vtt
  if (source === "srt") return { text: srtToVtt(text), format: "vtt", converted: true };
  return { text: String(text || ""), format: source, converted: false };
}

export default { detectSubtitleFormat, srtToVtt, vttToSrt, convertSubtitle };
