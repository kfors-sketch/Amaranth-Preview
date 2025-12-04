// /api/admin/debug.js
import { kv } from "@vercel/kv";
import {
  normalizeFrequency,
} from "./report-scheduler.js";

import {
  computeDailyWindow,
  computeWeeklyWindow,
  computeTwicePerMonthWindow,
  computeMonthlyWindow
} from "./report-scheduler.js";

// Exposed function to be called from router.js
export async function debugScheduleForItem(id) {
  const cfg = (await kv.hgetall(`itemcfg:${id}`)) || {};

  const publishStart = cfg.publishStart || null;
  const publishEnd   = cfg.publishEnd   || null;

  const freqRaw = cfg.reportFrequency ?? cfg.report_frequency;
  const freq = normalizeFrequency(freqRaw);

  // pointer
  const lastWindowEndKey = `itemcfg:${id}:last_window_end_ms`;
  const lastWindowEndRaw = await kv.get(lastWindowEndKey);
  let lastWindowEndMs = null;
  if (lastWindowEndRaw != null && lastWindowEndRaw !== "") {
    const n = Number(lastWindowEndRaw);
    if (Number.isFinite(n)) lastWindowEndMs = n;
  }

  const now = new Date();

  // Decide window
  let debugWindow;
  switch (freq) {
    case "daily":
      debugWindow = computeDailyWindow(now, lastWindowEndMs);
      break;
    case "weekly":
      debugWindow = computeWeeklyWindow(now, lastWindowEndMs);
      break;
    case "twice-per-month":
      debugWindow = computeTwicePerMonthWindow(now, lastWindowEndMs);
      break;
    case "monthly":
    default:
      debugWindow = computeMonthlyWindow(now, lastWindowEndMs);
      break;
  }

  return {
    ok: true,
    id,
    publishStart,
    publishEnd,
    freqRaw,
    freqNormalized: freq,
    lastWindowEndMs,
    nowUTC: now.toISOString(),
    debugWindow
  };
}