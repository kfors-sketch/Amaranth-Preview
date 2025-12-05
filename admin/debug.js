// admin/debug.js
//
// Server-side debug helpers used by /api/router:
// - Smoketest for KV + env
// - Last mail log
// - Schedule window debugger for a single item
//
// NOTE: report-scheduler.js and core.js live in /api/admin, so we import
// them with ../api/admin/...

import { kv } from "@vercel/kv";
import {
  normalizeReportFrequency,
  computeDailyWindow,
  computeWeeklyWindow,
  computeTwicePerMonthWindow,
  computeMonthlyWindow,
} from "../api/admin/report-scheduler.js";

import {
  MAIL_LOG_KEY,
  kvGetSafe,
} from "../api/admin/core.js";

/* -------------------------------------------------------------------------- */
/* 1. Smoketest — verifies KV, runtime, and key env vars                      */
/* -------------------------------------------------------------------------- */
export async function handleSmoketest() {
  const out = {
    ok: true,
    runtime: process.env.VERCEL ? "vercel" : "local",
    node: process.versions?.node || "unknown",
    env: {
      SITE_BASE_URL: process.env.SITE_BASE_URL ? "set" : "missing",
      REPORT_TOKEN: process.env.REPORT_TOKEN ? "set" : "missing",
    },
    kv: "not-tested",
  };

  try {
    await kv.set("debug:smoketest", "ok", { ex: 30 });
    const read = await kv.get("debug:smoketest");
    out.kv = read === "ok" ? "ok" : "unexpected-value";
  } catch (err) {
    out.kv = "error";
    out.kvError = String(err?.message || err);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* 2. Last mail log — returns recent email metadata                           */
/* -------------------------------------------------------------------------- */
export async function handleLastMail() {
  try {
    const data = await kvGetSafe(MAIL_LOG_KEY, {
      note: "No recent email log found",
    });
    return { ok: true, mail: data };
  } catch (err) {
    return {
      ok: false,
      error: "mail-log-failed",
      message: String(err?.message || err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Debug schedule — window computation for a single item                   */
/* -------------------------------------------------------------------------- */
export async function debugScheduleForItem(id) {
  const cfg = (await kv.hgetall(`itemcfg:${id}`)) || {};

  const publishStart = cfg.publishStart || null;
  const publishEnd   = cfg.publishEnd   || null;

  const freqRaw = cfg.reportFrequency ?? cfg.report_frequency;
  const freq = normalizeReportFrequency(freqRaw);

  const lastWindowEndKey = `itemcfg:${id}:last_window_end_ms`;
  const lastWindowEndRaw = await kv.get(lastWindowEndKey);

  let lastWindowEndMs = null;
  if (lastWindowEndRaw != null && lastWindowEndRaw !== "") {
    const n = Number(lastWindowEndRaw);
    if (Number.isFinite(n)) lastWindowEndMs = n;
  }

  const now = new Date();
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
    debugWindow,
  };
}