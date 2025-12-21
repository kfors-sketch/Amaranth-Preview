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
// - Orders index health
// - Itemcfg index health
// - Scheduler dry run (no emails)
// - Chair report preview (per item)
// - Order preview (per orderId)
// - Webhook session preview (per Stripe sessionId)
//
// NOTE: report-scheduler.js and core.js live in /api/admin, so we import
// them with ../api/admin/...

import { kv } from "@vercel/kv";

import {
  normalizeReportFrequency,
  computeDailyWindow,
  computeWeeklyWindow,
  // computeTwicePerMonthWindow, // TEMP DISABLED — not exported by ../api/admin/report-scheduler.js currently
  computeMonthlyWindow,
} from "../api/admin/report-scheduler.js";

import {
  MAIL_LOG_KEY,
  kvGetSafe,
  kvSmembersSafe,
  kvHgetallSafe,
  resend,
  RESEND_FROM,
  REPORTS_LOG_TO,
  getStripe,
  flattenOrderToRows,
  filterRowsByWindow,
} from "../api/admin/core.js";

/* -------------------------------------------------------------------------- */
/* TEMP NOTE (IMPORTANT)                                                      */
/* -------------------------------------------------------------------------- */
/*
  computeTwicePerMonthWindow used to work, but the module
  ../api/admin/report-scheduler.js no longer exports it. In ESM on Vercel,
  importing a missing named export is a fatal error and causes ALL /api/router
  requests (including admin_login) to return 500.

  For now:
  - we DO NOT import computeTwicePerMonthWindow (so the API can boot)
  - we treat "twice-per-month" as a monthly window fallback in debug tools
  - once the export is restored or renamed, re-enable the import and switch cases
*/

/* -------------------------------------------------------------------------- */
/* Helper: compute window safely (with twice-per-month fallback)              */
/* -------------------------------------------------------------------------- */
function computeWindowSafe(freq, now, lastWindowEndMs) {
  switch (freq) {
    case "daily":
      return computeDailyWindow(now, lastWindowEndMs);
    case "weekly":
      return computeWeeklyWindow(now, lastWindowEndMs);

    case "twice-per-month":
      // TEMP fallback until computeTwicePerMonthWindow is exported again
      return {
        ...computeMonthlyWindow(now, lastWindowEndMs),
        _note:
          "twice-per-month window disabled (missing export). Using monthly fallback.",
        _fallback: true,
      };

    case "monthly":
    default:
      return computeMonthlyWindow(now, lastWindowEndMs);
  }
}

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

      // Stripe (mode-aware, canonical)
      STRIPE_SECRET_KEY_TEST: process.env.STRIPE_SECRET_KEY_TEST ? "set" : "missing",
      STRIPE_SECRET_KEY_LIVE: process.env.STRIPE_SECRET_KEY_LIVE ? "set" : "missing",
      stripeReady:
        process.env.STRIPE_SECRET_KEY_TEST &&
        process.env.STRIPE_SECRET_KEY_LIVE
          ? "ok"
          : "missing",

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
  const publishEnd = cfg.publishEnd || null;

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

  const debugWindow = computeWindowSafe(freq, now, lastWindowEndMs);

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
  const rawAuth = headers.authorization || headers.Authorization || "";

  const auth = String(rawAuth || "");
  const envToken = (process.env.REPORT_TOKEN || "").trim();

  let providedToken = null;
  if (auth.toLowerCase().startsWith("bearer ")) {
    providedToken = auth.slice(7).trim();
  }

  const matches = !!providedToken && !!envToken && providedToken === envToken;

  return {
    ok: matches,
    providedToken: providedToken || "(none)",
    hasHeader: !!auth,
    hasEnvToken: !!envToken,
    matches,
    note: matches ? "Token matches REPORT_TOKEN" : "Token mismatch or missing.",
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

  const to = (url.searchParams.get("to") || REPORTS_LOG_TO || RESEND_FROM || "").trim();

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
    // twicePerMonth: computeTwicePerMonthWindow(now), // TEMP DISABLED — missing export
    twicePerMonth: {
      ...computeMonthlyWindow(now),
      _note:
        "twice-per-month window disabled (missing export). Showing monthly fallback.",
      _fallback: true,
    },
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

/* -------------------------------------------------------------------------- */
/* 8. Orders Health — sanity check for orders:index and order:<id>            */
/* -------------------------------------------------------------------------- */
export async function handleOrdersHealth() {
  const ids = await kvSmembersSafe("orders:index");
  const missing = [];
  const sampleRows = [];
  let earliest = null;
  let latest = null;

  for (const oid of ids) {
    const o = await kvGetSafe(`order:${oid}`, null);
    if (!o) {
      missing.push(oid);
      continue;
    }

    const rows = flattenOrderToRows(o);
    for (const r of rows) {
      const ts = Date.parse(r.date);
      if (Number.isFinite(ts)) {
        if (earliest == null || ts < earliest) earliest = ts;
        if (latest == null || ts > latest) latest = ts;
      }
    }

    if (sampleRows.length < 5) {
      sampleRows.push(...rows.slice(0, 2));
    }
  }

  return {
    ok: true,
    totalIndex: ids.length,
    missingCount: missing.length,
    missing,
    earliestISO: earliest ? new Date(earliest).toISOString() : null,
    latestISO: latest ? new Date(latest).toISOString() : null,
    sampleRows,
  };
}

/* -------------------------------------------------------------------------- */
/* 9. Itemcfg Health — sanity check for itemcfg:index and itemcfg:<id>        */
/* -------------------------------------------------------------------------- */
export async function handleItemcfgHealth() {
  const ids = await kvSmembersSafe("itemcfg:index");
  const items = [];

  for (const id of ids) {
    const cfg = await kvHgetallSafe(`itemcfg:${id}`);
    if (!cfg) {
      items.push({ id, missing: true });
      continue;
    }

    const freq = normalizeReportFrequency(cfg.reportFrequency ?? cfg.report_frequency);

    const chairEmails = Array.isArray(cfg.chairEmails) ? cfg.chairEmails : [];

    items.push({
      id,
      name: cfg.name || "",
      kind: cfg.kind || "",
      chairCount: chairEmails.length,
      publishStart: cfg.publishStart || "",
      publishEnd: cfg.publishEnd || "",
      reportFrequencyRaw: cfg.reportFrequency ?? cfg.report_frequency ?? "",
      reportFrequency: freq,
      missing: false,
    });
  }

  return { ok: true, count: items.length, items };
}

/* -------------------------------------------------------------------------- */
/* 10. Scheduler Dry Run — what *would* send, no emails                       */
/* -------------------------------------------------------------------------- */
export async function handleSchedulerDryRun() {
  const now = new Date();
  const nowMs = now.getTime();

  // Load all orders into flat rows once
  const orderIds = await kvSmembersSafe("orders:index");
  const allRows = [];
  for (const oid of orderIds) {
    const o = await kvGetSafe(`order:${oid}`, null);
    if (o) allRows.push(...flattenOrderToRows(o));
  }

  // Load all item configs
  const itemIds = await kvSmembersSafe("itemcfg:index");
  const itemsLog = [];

  for (const id of itemIds) {
    const cfg = (await kvHgetallSafe(`itemcfg:${id}`)) || {};

    const freqRaw = cfg.reportFrequency ?? cfg.report_frequency ?? "monthly";
    const freq = normalizeReportFrequency(freqRaw);

    const publishStart = cfg.publishStart || "";
    const publishEnd = cfg.publishEnd || "";

    const lastWindowEndKey = `itemcfg:${id}:last_window_end_ms`;
    const lastWindowEndRaw = await kv.get(lastWindowEndKey);
    let lastWindowEndMs = null;
    if (lastWindowEndRaw != null && lastWindowEndRaw !== "") {
      const n = Number(lastWindowEndRaw);
      if (Number.isFinite(n)) lastWindowEndMs = n;
    }

    const windowObj = computeWindowSafe(freq, now, lastWindowEndMs);

    const startMs = Number.isFinite(windowObj?.startMs) ? windowObj.startMs : null;
    const endMs = Number.isFinite(windowObj?.endMs) ? windowObj.endMs : null;

    // Rows for this item
    const idLower = String(id || "").toLowerCase();
    let rowsForItem = allRows.filter((r) => {
      const rid = String(r._itemId || r.item_id || "").toLowerCase();
      return rid === idLower;
    });
    const totalRows = rowsForItem.length;

    // Apply window
    let rowsInWindow = rowsForItem;
    if (startMs != null || endMs != null) {
      rowsInWindow = filterRowsByWindow(rowsForItem, {
        startMs: startMs ?? undefined,
        endMs: endMs ?? undefined,
      });
    }

    // Publish window gating
    const pubStartMs = publishStart ? Date.parse(publishStart) : NaN;
    const pubEndMs = publishEnd ? Date.parse(publishEnd) : NaN;
    const outsidePub =
      (!isNaN(pubStartMs) && nowMs < pubStartMs) ||
      (!isNaN(pubEndMs) && nowMs > pubEndMs);

    let reason = "";
    let wouldSend = false;

    if (outsidePub) {
      reason = "outside-publish-window";
    } else if (!rowsInWindow.length) {
      reason = "no-rows-in-window";
    } else {
      wouldSend = true;
      reason = "ok";
    }

    const chairEmails = Array.isArray(cfg.chairEmails) ? cfg.chairEmails : [];

    itemsLog.push({
      id,
      name: cfg.name || "",
      kind: cfg.kind || "",
      freqRaw,
      freqNormalized: freq,
      publishStart,
      publishEnd,
      lastWindowEndMs,
      window: windowObj,
      totalRows,
      rowsInWindow: rowsInWindow.length,
      wouldSend,
      reason,
      chairEmails,
    });
  }

  return {
    ok: true,
    nowUTC: now.toISOString(),
    items: itemsLog,
  };
}

/* -------------------------------------------------------------------------- */
/* 11. Chair Report Preview — per-item dry run (no email)                     */
/* -------------------------------------------------------------------------- */
export async function handleChairPreview({ id, scope = "full" }) {
  const itemId = String(id || "").trim();
  if (!itemId) {
    return { ok: false, error: "missing-id", message: "Item id is required." };
  }

  const cfg = await kvHgetallSafe(`itemcfg:${itemId}`);
  if (!cfg) {
    return {
      ok: false,
      error: "itemcfg-not-found",
      message: `No itemcfg found for ${itemId}`,
    };
  }

  const chairEmails = Array.isArray(cfg.chairEmails) ? cfg.chairEmails : [];

  const orderIds = await kvSmembersSafe("orders:index");
  const allRows = [];
  for (const oid of orderIds) {
    const o = await kvGetSafe(`order:${oid}`, null);
    if (o) allRows.push(...flattenOrderToRows(o));
  }

  const idLower = itemId.toLowerCase();
  let rowsForItem = allRows.filter((r) => {
    const rid = String(r._itemId || r.item_id || "").toLowerCase();
    return rid === idLower;
  });

  const totalRows = rowsForItem.length;

  const now = new Date();
  let rowsInScope = rowsForItem;
  let scopeInfo = {};

  if (scope === "current-month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    rowsInScope = filterRowsByWindow(rowsForItem, {
      startMs: start.getTime(),
      endMs: end.getTime(),
    });
    scopeInfo = { startUTC: start.toISOString(), endUTC: end.toISOString() };
  } else if (scope === "full" || !scope) {
    scope = "full";
    scopeInfo = { note: "No date filtering applied." };
  } else {
    return {
      ok: false,
      error: "unsupported-scope",
      message: `Scope '${scope}' is not supported yet. Use 'full' or 'current-month'.`,
    };
  }

  return {
    ok: true,
    id: itemId,
    kind: cfg.kind || "",
    scope,
    scopeInfo,
    chairEmails,
    totalRows,
    rowsInScope: rowsInScope.length,
    sampleRows: rowsInScope.slice(0, 25),
  };
}

/* -------------------------------------------------------------------------- */
/* 12. Order Preview — inspect a stored order and its flattened rows          */
/* -------------------------------------------------------------------------- */
export async function handleOrderPreview(orderId) {
  const oid = String(orderId || "").trim();
  if (!oid) {
    return { ok: false, error: "missing-id", message: "Order id is required." };
  }

  const order = await kvGetSafe(`order:${oid}`, null);
  if (!order) {
    return {
      ok: false,
      error: "order-not-found",
      message: `No order stored as order:${oid}`,
    };
  }

  const rows = flattenOrderToRows(order);

  return {
    ok: true,
    orderId: oid,
    status: order.status || null,
    createdAt: order.createdAt || order.created || null,
    rowCount: rows.length,
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/* 13. Webhook Session Preview — Stripe checkout.session details              */
/* -------------------------------------------------------------------------- */
export async function handleWebhookPreview(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    return {
      ok: false,
      error: "missing-session-id",
      message: "Stripe checkout session id is required.",
    };
  }

  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      error: "stripe-not-configured",
      message: "Stripe client is not available.",
    };
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sid, {
      expand: ["payment_intent", "line_items"],
    });

    return {
      ok: true,
      session: {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_details: session.customer_details || null,
        metadata: session.metadata || null,
        line_items: session.line_items ? session.line_items.data : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: "session-retrieve-failed",
      message: String(err?.message || err),
    };
  }
}
