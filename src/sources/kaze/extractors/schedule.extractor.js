/*
 * ======= • ======= • ======= • ======= • =======• =======
 * APIKuoshi — internal lane module

 *
 * @description
 *   Extracts anime schedule for a specific date.
 *   Returns airing times and episode numbers for scheduled anime.
 *
 * @exports
 *   extractSchedule
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import * as cheerio from "cheerio";
import { URLS } from "../configs/dataUrl.js";
import { fetchWithMirror } from "../helper/mirror.helper.js";

// ══════════════════════════════════════════════════════════════
// SCHEDULE EXTRACTION
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Extract anime schedule for a specific date ----
/**
 * Fetches and parses the anime schedule for a given date.
 * Returns airing times and episode numbers for scheduled anime.
 *
 * @param {string} date - Date to fetch schedule for (format: YYYY-MM-DD)
 * @returns {Promise<Array<Object>>} Array of scheduled anime objects
 * @returns {string} return.slug - URL slug for the anime
 * @returns {string} return.title - Anime title
 * @returns {string} return.time - Airing time
 * @returns {number} return.episode_no - Episode number
 *
 * @example
 *   const schedule = await extractSchedule("2024-01-15");
 *   console.log(schedule[0].time); // Airing time
 *   console.log(schedule[0].episode_no); // Episode number
 */
const extractSchedule = async (date) => {
  try {
    // NOTE: The schedule data is loaded via AJAX endpoint, not a static page.
    // v2.6.0: the kaze adapter now threads a date param through — when
    // omitted, the upstream's "today" is used (UTC-stripped YYYY-MM-DD).
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, "0");
    const d = String(today.getUTCDate()).padStart(2, "0");
    const dateArg = date || `${y}-${m}-${d}`;
    const path = `/ajax/schedule?date=${encodeURIComponent(dateArg)}`;
    const { data: raw } = await fetchWithMirror(path, {
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });

    // NOTE: Parse JSON response first — fetchWithMirror returns raw text by default
    let parsed = raw;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    }
    const html = parsed?.result || "";
    const $ = cheerio.load(html);

    // v2.6.0 — anchor the schedule to a UTC midnight so airingAt
    // math is timezone-stable across the server's deployment. The
    // kaze "time" string ("23:00") is the local airing time in the
    // site's timezone; for schedule display purposes we attach it to
    // the requested date's UTC midnight and treat the hour:minute as
    // a UTC offset. Clients who need strict TZ accuracy can read the
    // raw `airingTime` string instead.
    const [Y, M, D] = String(dateArg).split("-").map(n => parseInt(n, 10));
    const dayUtcMidnight = Date.UTC(Y, M - 1, D, 0, 0, 0) / 1000;

    const schedule = [];

    // NOTE: Schedule items live inside .item with .time, .ep, .title structure
    $(".item").each((i, el) => {
      const title = $(el).find(".title").text().trim() || "";
      const jpTitle = $(el).find(".title").attr("data-jp") || "";
      const time = $(el).find(".time").text().trim() || "";
      const episodeText = $(el).find(".ep span").text().trim() || "";
      const episodeNo = parseInt(episodeText.replace(/\D/g, "")) || 0;

      // v2.6.0 — extract the REAL listing link when available so the
      // slug is the upstream's actual listing slug, not a fabricated
      // title-kebab. Falls back to title-kebab for items with no link.
      const href = $(el).find("a").first().attr("href") || "";
      let slug = "";
      if (href) {
        const m = href.match(/\/(?:watch|anime|title|series)\/([^/?#]+)/);
        if (m) slug = m[1];
      }
      if (!slug) slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "";

      // v2.6.0 — compute airingAt (unix seconds) from the time string.
      // "23:00" → 23*3600 + 0*60 seconds after UTC midnight of the date.
      let airingAt = null;
      const tm = time.match(/(\d{1,2}):(\d{2})/);
      if (tm) {
        const h = parseInt(tm[1], 10);
        const min = parseInt(tm[2], 10);
        airingAt = dayUtcMidnight + (h * 3600) + (min * 60);
      }

      if (title) {
        schedule.push({
          slug,
          title,
          japaneseTitle: jpTitle,
          time,                                  // raw "23:00" string (kept for display)
          airingTime: time,                       // v2.6.0 alias (matches /api/home shape)
          airingAt,                               // v2.6.0 unix seconds
          episode_no: episodeNo,
          airingEpisode: episodeNo,               // v2.6.0 alias (matches /api/home shape)
        });
      }
    });

    return schedule;
  } catch (error) {
    throw error;
  }
};

export { extractSchedule };

// ══════════════════════════════════════════════════════════════ END: schedule.extractor.js
