// admin/debug.js
//
// Server-side debug helpers used by /api/router:
// - Smoketest for KV + env
// - Last mail log
// - Schedule window debugger for a single item
// - Token test
// - Stripe test
// - Resend test
// - Scheduler full diagnostic
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
  resend,
  RESEND_FROM,
  REPORTS_LOG_TO,
  getStripe,
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
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? "set" : "missing",
      RESEND_API_KEY: process.env.RESEND_API_KEY ? "set" : "missing",
      RESEND_FROM: RESEND_FROM ? "set" : "missing",
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
    out.ok = false;
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

/* -------------------------------------------------------------------------- */
/* 4. Token Test — verifies Authorization bearer matches REPORT_TOKEN         */
/* -------------------------------------------------------------------------- */
export async function handleTokenTest(req) {
  const headers = (req && req.headers) || {};
  const rawAuth =
    headers.authorization ||
    headers.Authorization ||
    "";

  const auth = String(rawAuth || "");
  const envToken = (process.env.REPORT_TOKEN || "").trim();

  let providedToken = null;
  if (auth.toLowerCase().startsWith("bearer ")) {
    providedToken = auth.slice(7).trim();
  }

  const matches =
    !!providedToken && !!envToken && providedToken === envToken;

  return {
    ok: matches,
    providedToken: providedToken || "(none)",
    hasHeader: !!auth,
    hasEnvToken: !!envToken,
    matches,
    note: matches
      ? "Token matches REPORT_TOKEN"
      : "Token mismatch or missing.",
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Stripe Test — lightweight connectivity (public safe)                    */
/* -------------------------------------------------------------------------- */
export async function handleStripeTest() {
  const out = {
    ok: true,
    hasKey: !!process.env.STRIPE_SECRET_KEY,
    reachable: false,
    error: null,
  };

  if (!out.hasKey) {
    out.ok = false;
    out.error = "STRIPE_SECRET_KEY missing";
    return out;
  }

  try {
    const stripe = await getStripe();
    if (!stripe) {
      out.ok = false;
      out.error = "Stripe client unavailable";
      return out;
    }

    // Simple safe ping
    await stripe.paymentIntents.list({ limit: 1 });
    out.reachable = true;
  } catch (err) {
    out.ok = false;
    out.error = String(err?.message || err);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* 6. Resend Test — optional real test email                                  */
/* -------------------------------------------------------------------------- */
export async function handleResendTest(req, urlLike) {
  // Support either a pre-parsed URL (from router) or build from req.url/host
  let url;
  if (urlLike && urlLike.searchParams) {
    url = urlLike;
  } else {
    const base = `http://${(req && req.headers && req.headers.host) || "localhost"}`;
    url = new URL(req.url || "/api/router", base);
  }

  const to =
    (url.searchParams.get("to") ||
      REPORTS_LOG_TO ||
      RESEND_FROM ||
      "").trim();

  const out = {
    ok: true,
    hasClient: !!resend,
    hasFrom: !!RESEND_FROM,
    to,
    sent: false,
    error: null,
  };

  if (!resend) {
    out.ok = false;
    out.error = "RESEND_API_KEY missing";
    return out;
  }
  if (!RESEND_FROM) {
    out.ok = false;
    out.error = "RESEND_FROM missing";
    return out;
  }
  if (!to) {
    out.ok = false;
    out.error = "Recipient missing";
    return out;
  }

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to,
      subject: "Amaranth Debug — Resend API Test",
      html: "<p>This is a debug test message.</p>",
    });
    out.sent = true;
  } catch (err) {
    out.ok = false;
    out.error = String(err?.message || err);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* 7. Scheduler Diagnostic — all windows + normalization tests                */
/* -------------------------------------------------------------------------- */
export async function handleSchedulerDiagnostic() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

  const windows = {
    daily: computeDailyWindow(now),
    weekly: computeWeeklyWindow(now),
    twicePerMonth: computeTwicePerMonthWindow(now),
    monthly: computeMonthlyWindow(now),
  };

  const samples = [
    "",
    "daily",
    "week",
    "weekly",
    "twice",
    "twice-per-month",
    "monthly",
    "month",
    "weird-value",
  ];

  const normalized = samples.map((s) => ({
    raw: s,
    normalized: normalizeReportFrequency(s),
  }));

  return {
    ok: true,
    nowUTC: now.toISOString(),
    timezone: tz,
    windows,
    normalized,
  };
}