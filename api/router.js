// /api/router.js
import crypto from "crypto";

import {
  kv,
  getStripe,
  getStripePublishableKey,
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,
  REQ_OK,
  REQ_ERR,
  cents,
  dollarsToCents,
  toCentsAuto,
  kvGetSafe,
  kvHsetSafe,
  kvSaddSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvSmembersSafe,
  kvDelSafe,
  sendWithRetry,
  loadAllOrdersWithRetry,
  parseDateISO,
  parseYMD,
  sortByDateAsc,
  baseKey,
  normalizeKey,
  normalizeReportFrequency,
  getEffectiveSettings,
  filterRowsByWindow,
  applyItemFilters,
  MAIL_LOG_KEY,
  recordMailLog,
  fetchSessionAndItems,
  getChairEmailsForItemId,
  saveOrderFromSession,
  applyRefundToOrder,
  flattenOrderToRows,
  absoluteUrl,
  renderOrderEmailHTML,
  sendOrderReceipts,
  buildCSV,
  buildCSVSelected,
  objectsToXlsxBuffer,
  collectAttendeesFromOrders,
  sendItemReportEmailInternal,
  REALTIME_CHAIR_KEY_PREFIX,
  sendRealtimeChairEmailsForOrder,
  maybeSendRealtimeChairEmails,
  // checkout mode helpers + purge
  getCheckoutSettingsRaw,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
  purgeOrdersByMode,

  // ✅ Admin patch helpers
  patchOrderCourtFields,
  rehashOrderAfterAdminPatch,
  clearOrdersCache,

  // ✅ Receipts ZIP helpers
  emailWeeklyReceiptsZip,
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,
} from "./admin/core.js";

import { getReportingPrefs, setReportingPrefs, resolveChannel, shouldSendReceiptZip } from "./admin/report-channel.js";


import {
  isInternationalOrder,
  computeInternationalFeeCents,
  buildInternationalFeeLineItem,
} from "./admin/fees.js";

import { handleAdminLogin, verifyAdminToken } from "./admin/security.js";

// Year-over-year helpers (orders / purchasers / people / amount)
import {
  listIndexedYears,
  getYearSummary,
  getMultiYearSummary,
} from "./admin/yearly-reports.js";

// scheduler + debug helpers
import {
  debugScheduleForItem,
  handleSmoketest,
  handleLastMail,
  handleTokenTest,
  handleStripeTest,
  handleResendTest,
  handleSchedulerDiagnostic,
  handleOrdersHealth,
  handleItemcfgHealth,
  handleSchedulerDryRun,
  handleChairPreview,
  handleOrderPreview,
  handleWebhookPreview,
} from "../admin/debug.js";

// ============================================================================
// BETTER ERROR DETAILS (safe for end-users)
// ============================================================================
function getRequestId(req) {
  return (
    req?.headers?.["x-vercel-id"] ||
    req?.headers?.["x-request-id"] ||
    `local-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );
}

function toSafeError(err) {
  const e = err || {};
  const name = String(e.name || "Error");
  const message = String(e.message || e.toString?.() || "Unknown error");

  const stripe = {};
  if (e.type) stripe.type = String(e.type);
  if (e.code) stripe.code = String(e.code);
  if (e.param) stripe.param = String(e.param);
  if (e.decline_code) stripe.decline_code = String(e.decline_code);
  if (e.statusCode || e.status_code)
    stripe.status = Number(e.statusCode || e.status_code);

  const safe = {
    name,
    message,
    stackTop: typeof e.stack === "string" ? e.stack.split("\n")[0] : "",
  };

  if (Object.keys(stripe).length) safe.stripe = stripe;
  return safe;
}

function errResponse(res, status, code, req, err, extra = {}) {
  const requestId = getRequestId(req);
  const safe = toSafeError(err);
  console.error(`[router] ${code} requestId=${requestId}`, err);
  return REQ_ERR(res, status, code, {
    requestId,
    error: safe,
    ...extra,
  });
}

// ============================================================================
// RAW BODY HELPERS (required for Stripe webhook signature verification)
// ============================================================================
async function readRawBody(req) {
  if (req._rawBodyBuffer) return req._rawBodyBuffer;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  req._rawBodyBuffer = buf;
  return buf;
}

async function readJsonBody(req) {
  const buf = await readRawBody(req);
  const text = buf.toString("utf8") || "";
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON body: ${e?.message || e}`);
  }
}

// ---- Admin auth helper ----
async function requireAdminAuth(req, res) {
  const headers = req.headers || {};
  const rawAuth = headers.authorization || headers.Authorization || "";

  const auth = String(rawAuth || "");
  const lower = auth.toLowerCase();
  if (!lower.startsWith("bearer ")) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }

  const token = auth.slice(7).trim();
  if (!token) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }

  const legacy = (process.env.REPORT_TOKEN || "").trim();
  if (legacy && token === legacy) return true;

  try {
    const result = await verifyAdminToken(token);
    if (result.ok) return true;
  } catch (e) {
    console.error("verifyAdminToken failed:", e?.message || e);
  }

  REQ_ERR(res, 401, "unauthorized");
  return false;
}

function getUrl(req) {
  const host = req?.headers?.host || req?.headers?.["host"] || "localhost";
  return new URL(req.url, `http://${host}`);
}

async function getEffectiveReportMode() {
  const prefs = await getReportingPrefs();
  const isProduction =
    String(process.env.VERCEL_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const mode = resolveChannel({ requested: prefs.channel, isProduction });
  return { prefs, mode };
}


// Pull order mode from Stripe session metadata (preferred), else fall back to current.
async function resolveModeFromSession(sessionLike) {
  try {
    const md = sessionLike?.metadata || {};
    const m =
      String(md.order_channel || md.order_mode || "")
        .trim()
        .toLowerCase() || "";
    if (m === "test" || m === "live_test" || m === "live") return m;
  } catch {}
  try {
    const eff = await getEffectiveOrderChannel();
    if (eff === "test" || eff === "live_test" || eff === "live") return eff;
  } catch {}
  return "test";
}

// Stripe session IDs include cs_test_ or cs_live_
function inferStripeEnvFromCheckoutSessionId(id) {
  const s = String(id || "").trim();
  if (s.startsWith("cs_live_")) return "live";
  if (s.startsWith("cs_test_")) return "test";
  return "";
}

// ---------------- Catalog category helpers ----------------
const CATALOG_CATEGORIES_KEY = "catalog:categories";

// ---------------- Feature Flags ----------------
const FEATURE_FLAGS_KEY = "feature_flags";

const DEFAULT_FEATURE_FLAGS = {
  supplies_live: false,
  supplies_preview: false,
  banquets_v2_preview: false,
  catalog_v2_preview: false,
};

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !!v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

async function loadFeatureFlagsSafe() {
  const raw = (await kvGetSafe(FEATURE_FLAGS_KEY, null)) || null;

  const storedFlags =
    raw && typeof raw === "object"
      ? raw.flags && typeof raw.flags === "object"
        ? raw.flags
        : raw
      : {};

  const merged = { ...DEFAULT_FEATURE_FLAGS, ...(storedFlags || {}) };

  const cleaned = {};
  for (const k of Object.keys(DEFAULT_FEATURE_FLAGS))
    cleaned[k] = coerceBool(merged[k]);

  const updatedAt =
    raw && typeof raw === "object" && typeof raw.updatedAt === "string"
      ? raw.updatedAt
      : "";

  return { flags: cleaned, updatedAt };
}

function normalizeCat(catRaw) {
  const cat = String(catRaw || "catalog").trim().toLowerCase();
  const safe = cat.replace(/[^a-z0-9_-]/g, "");
  return safe || "catalog";
}

function catalogItemsKeyForCat(catRaw) {
  const cat = normalizeCat(catRaw);
  if (!cat || cat === "catalog") return "products";
  return `products:${cat}`;
}

async function getCatalogCategoriesSafe() {
  const list = (await kvGetSafe(CATALOG_CATEGORIES_KEY, [])) || [];
  const out = Array.isArray(list) ? list.slice() : [];

  const ensure = (cat, title) => {
    const c = String(cat || "").trim().toLowerCase();
    if (!c) return;
    const has = out.some(
      (x) => String(x?.cat || "").trim().toLowerCase() === c
    );
    if (!has) out.push({ cat: c, title });
  };

  ensure("catalog", "Product Catalog");
  ensure("supplies", "Supplies");
  ensure("charity", "Charity");

  out.sort((a, b) => {
    const ac = String(a?.cat || "").toLowerCase();
    const bc = String(b?.cat || "").toLowerCase();
    if (ac === "catalog" && bc !== "catalog") return -1;
    if (bc === "catalog" && ac !== "catalog") return 1;
    return String(a?.title || ac).localeCompare(String(b?.title || bc));
  });

  return out;
}

// ============================================================================
// ITEMCFG MERGE HELPERS (fixes “admin shows daily but scheduler sees monthly”)
// - We must NEVER overwrite reportFrequency to "monthly" just because the field
//   was missing in the save payload.
// ============================================================================
function splitEmails(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeChairEmails(raw, fallbackEmail) {
  if (Array.isArray(raw))
    return raw.map((s) => String(s).trim()).filter(Boolean);
  const from = raw || fallbackEmail || "";
  return splitEmails(from);
}

function pickNonEmptyString(a, b, fallback = "") {
  const aa = String(a ?? "").trim();
  if (aa) return aa;
  const bb = String(b ?? "").trim();
  if (bb) return bb;
  return fallback;
}

function computeMergedFreq(incomingRaw, existingCfg, defaultFreq) {
  const raw =
    incomingRaw ??
    existingCfg?.reportFrequency ??
    existingCfg?.report_frequency ??
    defaultFreq;

  return normalizeReportFrequency(raw);
}

// ============================================================================
// ✅ NEW: Immutable order hash + createdAt markers (tamper detection)
// - Writes once per order ID:
//     order:<id>:createdAt
//     order:<id>:hash
// - Never overwrites if already present.
// ============================================================================
function stableStringify(value) {
  const seen = new WeakSet();

  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;

    if (seen.has(v)) return "[Circular]";
    seen.add(v);

    if (Array.isArray(v)) return v.map(walk);

    const out = {};
    const keys = Object.keys(v).sort();
    for (const k of keys) out[k] = walk(v[k]);
    return out;
  };

  return JSON.stringify(walk(value));
}

function normalizeOrderForHash(order) {
  // Keep “what matters” for integrity. Exclude volatile/runtime markers.
  const o = order && typeof order === "object" ? order : {};
  const clone = { ...o };

  // strip volatile fields if present
  delete clone._raw;
  delete clone._debug;
  delete clone._requestId;
  delete clone._email;
  delete clone._emailStatus;
  delete clone._emailsSentAt;
  delete clone._postEmailsSentAt;
  delete clone.post_emails_sent;
  delete clone.admin_receipt_sent;

  // If your order has internal timestamps that can change, exclude them:
  // (We DO store createdAt separately as immutable KV marker.)
  delete clone.updatedAt;
  delete clone.lastUpdatedAt;

  return clone;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

async function ensureOrderIntegrityMarkers(order, requestId) {
  try {
    const id = String(order?.id || "").trim();
    if (!id) return;

    const createdKey = `order:${id}:createdAt`;
    const hashKey = `order:${id}:hash`;

    // createdAt: write-once
    const existingCreated = await kvGetSafe(createdKey, "");
    if (!existingCreated) {
      const createdAt =
        String(order?.createdAt || order?.created_at || "").trim() ||
        new Date().toISOString();
      await kvSetSafe(createdKey, createdAt);
    }

    // hash: write-once
    const existingHash = await kvGetSafe(hashKey, "");
    if (!existingHash) {
      const normalized = normalizeOrderForHash(order);
      const payload = stableStringify(normalized);
      const hash = sha256Hex(payload);
      await kvSetSafe(hashKey, hash);
    }
  } catch (e) {
    // Never block user for integrity marker issues — just log.
    console.error("[order-hash] failed", {
      requestId,
      orderId: order?.id || null,
      message: e?.message || String(e),
    });
  }
}

// ============================================================================
// ✅ NEW: Lockdown mode (blocks admin write actions during event week / emergencies)
// - Source of truth:
//   1) KV key: security:lockdown (object or boolean)
//   2) Env: LOCKDOWN_ON (true/false)
// - Bypass by IP list (env LOCKDOWN_BYPASS_IPS, comma-separated)
// ============================================================================
const LOCKDOWN_KEY = "security:lockdown";

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    ""
  );
}

function ipMatchesAllowlist(ip, allowlist) {
  const raw = String(ip || "").trim();
  if (!raw) return false;

  // x-forwarded-for can contain "ip, ip, ip"
  const first = raw.split(",")[0].trim();

  for (const a of allowlist) {
    const aa = String(a || "").trim();
    if (!aa) continue;

    // exact match
    if (first === aa) return true;

    // allow prefix match for IPv6 shorthand / internal ranges if user supplies like "192.168."
    if (aa.endsWith("*")) {
      const pref = aa.slice(0, -1);
      if (first.startsWith(pref)) return true;
    }
  }
  return false;
}

async function getLockdownStateSafe() {
  // KV wins over env
  const raw = await kvGetSafe(LOCKDOWN_KEY, null);

  // allow either boolean or object
  if (typeof raw === "boolean") {
    return { on: raw, message: raw ? "Lockdown is enabled." : "", updatedAt: "" };
  }

  if (raw && typeof raw === "object") {
    const on = coerceBool(raw.on ?? raw.enabled ?? raw.locked ?? false);
    const message = String(raw.message || raw.note || "").trim();
    const updatedAt = String(raw.updatedAt || "").trim();
    return { on, message, updatedAt };
  }

  const envOn = coerceBool(process.env.LOCKDOWN_ON || "");
  return {
    on: envOn,
    message: envOn ? "Lockdown is enabled (env)." : "",
    updatedAt: "",
  };
}

async function isLockdownBypassed(req) {
  const allowIps = splitCsv(process.env.LOCKDOWN_BYPASS_IPS || "");
  if (!allowIps.length) return false;
  return ipMatchesAllowlist(getClientIp(req), allowIps);
}

function isWriteAction(action) {
  // Anything that mutates settings/items/orders should be blocked in lockdown.
  // (We keep a conservative list to prevent surprises.)
  return [
    "save_feature_flags",
    "purge_orders",
    "save_banquets",
    "save_addons",
    "save_products",
    "save_catalog_items",
    "save_settings",
    "save_checkout_mode",
    "clear_orders",
    "create_refund",
    "mark_manual_refund",
    "unmark_manual_refund",
    "send_full_report",
    "send_month_to_date",
    "send_monthly_chair_reports",
    "send_end_of_event_reports",
    // You can decide whether to allow these during lockdown:
    "send_item_report",
    "register_item",
  ].includes(String(action || ""));
}

async function enforceLockdownIfNeeded(req, res, action, requestId) {
  const st = await getLockdownStateSafe();
  if (!st.on) return true;

  // bypass
  if (await isLockdownBypassed(req)) return true;

  // Only block write actions; allow read-only admin endpoints.
  if (!isWriteAction(action)) return true;

  return !REQ_ERR(res, 423, "lockdown", {
    requestId,
    message:
      st.message ||
      "Site is in lockdown mode. Admin write actions are temporarily disabled.",
    updatedAt: st.updatedAt || "",
    action,
  });
}

// ============================================================================
// ✅ NEW: Post-order email helper
// - Ensures receipts (including admin copy) are sent immediately after finalize,
//   across ALL finalize paths (manual finalize, finalize_checkout, webhook).
// - Also sends realtime chair emails.
// - Adds idempotency keys to avoid double-sends.
// - Never throws to end-user on email failure.
// ============================================================================
function postEmailKey(orderId) {
  return `order:${String(orderId || "").trim()}:post_emails_sent`;
}

function adminReceiptKey(orderId) {
  return `order:${String(orderId || "").trim()}:admin_receipt_sent`;
}

async function getAdminReceiptRecipientsSafe() {
  // Admin receipt copy should ONLY go to EMAIL_RECEIPTS.
  // (Reports and other operational mail can still go to REPORTS_LOG_TO / REPORTS_BCC elsewhere.)
  //
  // Priority:
  // 1) settings override: EMAIL_RECEIPTS (comma list)
  // 2) env: EMAIL_RECEIPTS
  try {
    const { effective } = await getEffectiveSettings();
    const pick = (effective?.EMAIL_RECEIPTS || "").trim();
    const list = splitEmails(pick);
    if (list.length) return list;
  } catch {}

  const pickEnv = (process.env.EMAIL_RECEIPTS || "").trim();
  return splitEmails(pickEnv);
}

async function sendAdminReceiptCopyOnce(order, requestId) {
  try {
    if (!order?.id) return;
    if (!resend) return; // no email system configured

    // Idempotency: prevent duplicates if finalize paths overlap.
    const already = await kvGetSafe(adminReceiptKey(order.id), "");
    if (already) return;

    const toList = await getAdminReceiptRecipientsSafe();
    if (!toList.length) return;

    // NOTE: sendOrderReceipts() may already include admin copy in your core.js.
    // This helper is a "guarantee" path, but idempotent to prevent spam.
    const html =
      (await renderOrderEmailHTML(order, { includeAdminNote: true })) ||
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
        <h2>Order receipt</h2>
        <p>orderId: ${String(order.id).replace(/</g, "&lt;")}</p>
      </div>`;

    const subject = `Admin copy — receipt — Order ${order.id}`;

    const payload = {
      from: RESEND_FROM || "onboarding@resend.dev",
      to: toList,
      subject,
      html,
      reply_to: REPLY_TO || undefined,
    };

    const retry = await sendWithRetry(
      () => resend.emails.send(payload),
      "admin-receipt"
    );

    if (retry.ok) {
      const sendResult = retry.result;
      await kvSetSafe(adminReceiptKey(order.id), new Date().toISOString());
      try {
        await recordMailLog({
          ts: Date.now(),
          from: payload.from,
          to: toList,
          subject,
          resultId: sendResult?.id || null,
          kind: "admin-receipt",
          status: "queued",
        });
      } catch {}
    } else {
      const err = retry.error;
      console.error("[admin-receipt] send failed", {
        requestId,
        orderId: order?.id || null,
        message: err?.message || String(err),
      });
      try {
        await recordMailLog({
          ts: Date.now(),
          from: payload.from,
          to: toList,
          subject,
          kind: "admin-receipt",
          status: "error",
          error: String(err?.message || err),
        });
      } catch {}
    }
  } catch (e) {
    console.error("[admin-receipt] unexpected failure", {
      requestId,
      orderId: order?.id || null,
      message: e?.message || String(e),
    });
  }
}

async function sendPostOrderEmails(order, requestId) {
  try {
    if (!order?.id) return;

    // Compatibility shim:
    // Older code paths (including some versions of core.js) look for RECEIPTS_ADMIN_TO.
    // Your project standard is EMAIL_RECEIPTS. Keep receipts routed correctly without
    // impacting reports.
    try {
      const er = (process.env.EMAIL_RECEIPTS || "").trim();
      if (!process.env.RECEIPTS_ADMIN_TO && er) process.env.RECEIPTS_ADMIN_TO = er;
    } catch {}


    // Idempotency to prevent double send when:
    // - user hits finalize endpoint and Stripe webhook also comes in
    // - page refresh retries finalize_checkout
    const already = await kvGetSafe(postEmailKey(order.id), "");
    if (already) return;

    // Set the idempotency marker early to avoid race-double-sends.
    await kvSetSafe(postEmailKey(order.id), new Date().toISOString());

    // 1) Receipts (buyer + chairs + admin copy, if core.js supports it)
    try {
      await sendOrderReceipts(order);
    } catch (err) {
      console.error("[post-email] sendOrderReceipts failed", {
        requestId,
        orderId: order?.id || null,
        message: err?.message || String(err),
      });
      try {
        await recordMailLog({
          ts: Date.now(),
          from: RESEND_FROM || "onboarding@resend.dev",
          to: [],
          subject: `receipts-failed order=${order?.id || ""}`,
          kind: "receipts",
          status: "error",
          error: String(err?.message || err),
        });
      } catch {}
    }

    // 1b) ✅ GUARANTEE: Admin copy right after order (idempotent)
    await sendAdminReceiptCopyOnce(order, requestId);

    // 2) Realtime chair emails (your existing logic)
    try {
      await maybeSendRealtimeChairEmails(order);
    } catch (err) {
      console.error("[post-email] maybeSendRealtimeChairEmails failed", {
        requestId,
        orderId: order?.id || null,
        message: err?.message || String(err),
      });
      try {
        await recordMailLog({
          ts: Date.now(),
          from: RESEND_FROM || "onboarding@resend.dev",
          to: [],
          subject: `realtime-chair-failed order=${order?.id || ""}`,
          kind: "realtime-chair",
          status: "error",
          error: String(err?.message || err),
        });
      } catch {}
    }
  } catch (e) {
    console.error("[post-email] unexpected failure", {
      requestId,
      orderId: order?.id || null,
      message: e?.message || String(e),
    });
  }
}


// ============================================================================
// ✅ VISITS COUNTER (KV ground truth)
// - Public endpoint: POST /api/router?action=track_visit  (no auth)
// - Optional GET:    /api/router?type=track_visit&path=/home.html (no auth)
// - Admin endpoints:
//     GET /api/router?type=visits_summary&mode=auto|test|live_test|live&days=30
//     GET /api/router?type=visits_pages&mode=auto|test|live_test|live&days=30&limit=50
//     GET /api/router?type=visits_export&mode=auto|test|live_test|live&days=30   (xlsx)
// - Stores totals + per-day + per-month + per-path, split by channel (test/live_test/live)
// ============================================================================
const VISITS_KEY_PREFIX = "visits";

function ymdUtc(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function ymUtc(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function normalizeVisitPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "/";

  // strip protocol/host if someone passed full URL
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      return normalizeVisitPath(u.pathname || "/");
    }
  } catch {}

  const noQuery = raw.split("?")[0].split("#")[0].trim();
  let out = noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
  out = out.replace(/\/{2,}/g, "/");
  if (out.length > 256) out = out.slice(0, 256);
  return out || "/";
}

function shouldCountVisit(pathname) {
  const p = String(pathname || "").toLowerCase();
  if (!p) return false;

  // exclude API + admin + common debug pages
  if (p.startsWith("/api/")) return false;
  if (p.startsWith("/admin/")) return false;
  if (p.includes("debug")) return false;

  // exclude obvious assets
  if (
    p.startsWith("/assets/") ||
    p.endsWith(".js") ||
    p.endsWith(".css") ||
    p.endsWith(".png") ||
    p.endsWith(".jpg") ||
    p.endsWith(".jpeg") ||
    p.endsWith(".webp") ||
    p.endsWith(".gif") ||
    p.endsWith(".svg") ||
    p.endsWith(".ico") ||
    p.endsWith(".map")
  )
    return false;

  return true;
}

async function kvIncrSafe(key, delta = 1) {
  try {
    if (kv && typeof kv.incrby === "function") {
      return await kv.incrby(key, delta);
    }
    if (kv && typeof kv.incr === "function") {
      if (delta === 1) return await kv.incr(key);
      // fall through for non-1 deltas
    }
  } catch {}

  const prev = Number(await kvGetSafe(key, 0)) || 0;
  const next = prev + Number(delta || 0);
  await kvSetSafe(key, next);
  return next;
}

async function kvScardSafe(key, fallback = 0) {
  try {
    if (kv && typeof kv.scard === "function") {
      return await kv.scard(key);
    }
  } catch {}
  return fallback;
}

function visitsKey(mode, parts) {
  const m = String(mode || "test").trim().toLowerCase() || "test";
  return [VISITS_KEY_PREFIX, m, ...parts].join(":");
}

async function trackVisitInternal({ path, mode, now, vid }) {
  const pathname = normalizeVisitPath(path);
  if (!shouldCountVisit(pathname)) return { ok: true, skipped: true, path: pathname };

  const d = now || new Date();
  const day = ymdUtc(d);
  const month = ymUtc(d);

  // totals
  const kTotal = visitsKey(mode, ["total"]);
  const kDayTotal = visitsKey(mode, ["day", day, "total"]);
  const kMonthTotal = visitsKey(mode, ["month", month, "total"]);

  // per-path
  const safePathKey = encodeURIComponent(pathname);
  const kDayPath = visitsKey(mode, ["day", day, "path", safePathKey]);
  const kMonthPath = visitsKey(mode, ["month", month, "path", safePathKey]);

  // unique sets (optional)
  const visitor = String(vid || "").trim();
  const hasVisitor = visitor && visitor.length >= 6;
  const kDayUniqueSet = visitsKey(mode, ["day", day, "unique_set"]);
  const kDayPathUniqueSet = visitsKey(mode, ["day", day, "path", safePathKey, "unique_set"]);

  const ops = [
    kvIncrSafe(kTotal, 1),
    kvIncrSafe(kDayTotal, 1),
    kvIncrSafe(kMonthTotal, 1),
    kvSaddSafe(visitsKey(mode, ["pages"]), pathname),
    kvIncrSafe(kDayPath, 1),
    kvIncrSafe(kMonthPath, 1),
  ];

  if (hasVisitor) {
    ops.push(kvSaddSafe(kDayUniqueSet, visitor));
    ops.push(kvSaddSafe(kDayPathUniqueSet, visitor));
  }

  await Promise.all(ops);

  return { ok: true, path: pathname, day, month, mode };
}

// Admin helpers for visit reads
async function resolveVisitsMode(qMode) {
  const mode = String(qMode || "auto").trim().toLowerCase();
  const effectiveMode =
    mode === "auto"
      ? await getEffectiveOrderChannel().catch(() => "test")
      : mode;

  if (!["test", "live_test", "live"].includes(effectiveMode)) {
    return { ok: false, effectiveMode, error: "invalid-mode" };
  }
  return { ok: true, effectiveMode };
}

async function getVisitsDailyRows(effectiveMode, days) {
  const base = `visits:${effectiveMode}`;
  const rows = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const total = Number(await kvGetSafe(`${base}:day:${day}:total`, 0)) || 0;
    const unique = Number(await kvScardSafe(`${base}:day:${day}:unique_set`, 0)) || 0;
    rows.push({ day, total, unique });
  }
  return rows; // newest-first
}

async function getVisitsTopPages(effectiveMode, days) {
  const base = `visits:${effectiveMode}`;
  const pages = (await kvSmembersSafe(`${base}:pages`)) || [];
  const results = [];

  for (const page of pages) {
    const pagePath = normalizeVisitPath(page);
    const enc = encodeURIComponent(pagePath);

    let total = 0;
    let unique = 0;

    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      total += Number(await kvGetSafe(`${base}:day:${d}:path:${enc}`, 0)) || 0;
      unique += Number(await kvScardSafe(`${base}:day:${d}:path:${enc}:unique_set`, 0)) || 0;
    }

    if (total > 0) results.push({ page: pagePath, total, unique });
  }

  results.sort((a, b) => b.total - a.total);
  return results;
}


// -------------- main handler --------------
export default async function handler(req, res) {
  const requestId = getRequestId(req);

  try {
    const url = getUrl(req);
    const q = Object.fromEntries(url.searchParams.entries());
    const action = url.searchParams.get("action");
    const type = url.searchParams.get("type");

// ---------- GET ----------
if (req.method === "GET") {
  // Small local helpers (avoid repeating logic)
  const resolveVisitsModeLocal = async () => {
    const modeRaw = String(q.mode || "auto").trim().toLowerCase();
    const effectiveMode =
      modeRaw === "auto"
        ? await getEffectiveOrderChannel().catch(() => "test")
        : modeRaw;

    if (effectiveMode !== "test" && effectiveMode !== "live_test" && effectiveMode !== "live") {
      return { ok: false, modeRaw, effectiveMode };
    }
    return { ok: true, modeRaw, effectiveMode };
  };

  const getScard = async (key) => {
    // kvScardSafe preferred
    if (typeof kvScardSafe === "function") {
      return Number(await kvScardSafe(key, 0)) || 0;
    }
    // fallback to kv.scard if available
    if (kv && typeof kv.scard === "function") {
      try {
        return Number(await kv.scard(key)) || 0;
      } catch {
        return 0;
      }
    }
    return 0;
  };

  // ✅ Public: track a visit (no auth)
  if (type === "track_visit") {
    try {
      const pathParam =
        url.searchParams.get("path") ||
        url.searchParams.get("p") ||
        url.pathname ||
        "/";
      const mode = await getEffectiveOrderChannel().catch(() => "test");
      const vidParam =
        url.searchParams.get("vid") ||
        url.searchParams.get("visitorId") ||
        url.searchParams.get("v") ||
        "";
      const out = await trackVisitInternal({
        path: pathParam,
        mode,
        now: new Date(),
        vid: vidParam,
      });
      return REQ_OK(res, { requestId, ...out });
    } catch (e) {
      return errResponse(res, 500, "track-visit-failed", req, e);
    }
  }

  // ================= VISITS: SUMMARY (ADMIN) =================
  if (type === "visits_summary") {
    if (!(await requireAdminAuth(req, res))) return;

    const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
    const m = await resolveVisitsModeLocal();
    if (!m.ok) return REQ_ERR(res, 400, "invalid-mode", { requestId, mode: m.modeRaw });

    const base = `visits:${m.effectiveMode}`;
    const rows = [];

    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const total = Number(await kvGetSafe(`${base}:day:${day}:total`, 0)) || 0;
      const unique = await getScard(`${base}:day:${day}:unique_set`);
      rows.push({ day, total, unique });
    }

    return REQ_OK(res, { requestId, ok: true, mode: m.effectiveMode, days, rows });
  }

  // ================= VISITS: TOP PAGES (ADMIN) =================
  if (type === "visits_pages") {
    if (!(await requireAdminAuth(req, res))) return;

    const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
    const limit = Math.max(1, Math.min(200, parseInt(q.limit || "50", 10) || 50));

    const m = await resolveVisitsModeLocal();
    if (!m.ok) return REQ_ERR(res, 400, "invalid-mode", { requestId, mode: m.modeRaw });

    const base = `visits:${m.effectiveMode}`;
    const pages = (await kvSmembersSafe(`${base}:pages`)) || [];

    const results = [];
    for (const page of pages) {
      const pagePath =
        typeof normalizeVisitPath === "function"
          ? normalizeVisitPath(page)
          : String(page || "/");
      const enc = encodeURIComponent(pagePath);

      let total = 0;
      let unique = 0;

      for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        total += Number(await kvGetSafe(`${base}:day:${day}:path:${enc}`, 0)) || 0;
        unique += await getScard(`${base}:day:${day}:path:${enc}:unique_set`);
      }

      if (total > 0) results.push({ page: pagePath, total, unique });
    }

    results.sort((a, b) => b.total - a.total);

    return REQ_OK(res, {
      requestId,
      ok: true,
      mode: m.effectiveMode,
      days,
      pages: results.slice(0, limit),
    });
  }

  // ================= VISITS: EXPORT XLSX (ADMIN) =================
  // One-sheet XLSX export using objectsToXlsxBuffer(headers, rows, [], sheetName)
  if (type === "visits_export") {
    if (!(await requireAdminAuth(req, res))) return;

    const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
    const m = await resolveVisitsModeLocal();
    if (!m.ok) return REQ_ERR(res, 400, "invalid-mode", { requestId, mode: m.modeRaw });

    const base = `visits:${m.effectiveMode}`;

    // Daily summary
    const daily = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const total = Number(await kvGetSafe(`${base}:day:${day}:total`, 0)) || 0;
      const unique = await getScard(`${base}:day:${day}:unique_set`);
      daily.push({ day, total, unique });
    }

    // Top pages (window totals)
    const pagesSet = (await kvSmembersSafe(`${base}:pages`)) || [];
    const topPages = [];

    for (const page of pagesSet) {
      const pagePath =
        typeof normalizeVisitPath === "function"
          ? normalizeVisitPath(page)
          : String(page || "/");
      const enc = encodeURIComponent(pagePath);

      let total = 0;
      let unique = 0;

      for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        total += Number(await kvGetSafe(`${base}:day:${day}:path:${enc}`, 0)) || 0;
        unique += await getScard(`${base}:day:${day}:path:${enc}:unique_set`);
      }

      if (total > 0) topPages.push({ page: pagePath, total, unique });
    }

    topPages.sort((a, b) => b.total - a.total);

    // One sheet export
    const rows = [];
    rows.push({ section: "Daily Summary", day: "", page: "", total: "", unique: "" });

    for (const r of daily) {
      rows.push({ section: "daily", day: r.day, page: "", total: r.total, unique: r.unique });
    }

    rows.push({ section: "", day: "", page: "", total: "", unique: "" });
    rows.push({ section: "Top Pages (window totals)", day: "", page: "", total: "", unique: "" });

    for (const p of topPages) {
      rows.push({ section: "page", day: "", page: p.page, total: p.total, unique: p.unique });
    }

    const headers = ["section", "day", "page", "total", "unique"];
    const buf = await objectsToXlsxBuffer(headers, rows, [], "Visits");

    const filename = `visits_${m.effectiveMode}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(buf);
    return;
  }

  // ===== existing debug endpoints continue unchanged =====

  if (type === "smoketest") {
    const out = await handleSmoketest();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "lastmail") {
    const out = await handleLastMail();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_mail_recent") {
    if (!(await requireAdminAuth(req, res))) return;

    const limitRaw = url.searchParams.get("limit") || "20";
    let limit = Number(limitRaw);
    if (!Number.isFinite(limit)) limit = 20;
    limit = Math.max(1, Math.min(200, Math.floor(limit)));

    let logs = [];
    try {
      logs = await kv.lrange("mail:logs", 0, limit - 1);
    } catch (e) {
      return errResponse(res, 500, "debug-mail-recent-failed", req, e);
    }

    return REQ_OK(res, { requestId, ok: true, limit, logs });
  }

  // ✅ IMPORTANT: keep GET open; do NOT close the GET block here.
  // The GET block should end only once, right before POST begins.



      if (type === "debug_token") {
        const out = await handleTokenTest(req);
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_stripe") {
        const out = await handleStripeTest();
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_resend") {
        const out = await handleResendTest(req, url);
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_scheduler") {
        const out = await handleSchedulerDiagnostic();
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_orders_health") {
        const out = await handleOrdersHealth();
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_itemcfg_health") {
        const out = await handleItemcfgHealth();
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_scheduler_dry_run") {
        const out = await handleSchedulerDryRun();
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_chair_preview") {
        const id = url.searchParams.get("id") || "";
        const scope = url.searchParams.get("scope") || "full";
        const out = await handleChairPreview({ id, scope });
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_order_preview") {
        const id = url.searchParams.get("id") || "";
        const out = await handleOrderPreview(id);
        return REQ_OK(res, { requestId, ...out });
      }

      if (type === "debug_webhook_preview") {
        const sessionId =
          url.searchParams.get("session_id") ||
          url.searchParams.get("sessionId") ||
          "";
        const out = await handleWebhookPreview(sessionId);
        return REQ_OK(res, { requestId, ...out });
      }

      // ✅ NEW: Lockdown status (admin-only; handy for quick checks)
      if (type === "receipts_zip_prefs") {
        if (!(await requireAdminAuth(req, res))) return;
        const prefs = await getReportingPrefs();
        const { mode } = await getEffectiveReportMode();
        return REQ_OK(res, { requestId, ok: true, prefs, mode });
      }

      if (type === "lockdown_status") {
        if (!(await requireAdminAuth(req, res))) return;
        const st = await getLockdownStateSafe();
        const bypass = await isLockdownBypassed(req);
        return REQ_OK(res, {
          requestId,
          ok: true,
          lockdown: st,
          bypass,
          ip: String(getClientIp(req) || ""),
        });
      }

      if (type === "year_index") {
        const years = await listIndexedYears();

        const slots = [];
        const seen = new Set();

        const addSlots = (list, category) => {
          if (!Array.isArray(list)) return;
          for (const item of list) {
            const key = String(item?.id || item?.slotKey || item?.slot || "").trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);

            const label = item?.name || item?.label || item?.slotLabel || key;
            slots.push({ key, label, category });
          }
        };

        const banquets = (await kvGetSafe("banquets", [])) || [];
        const addons = (await kvGetSafe("addons", [])) || [];

        addSlots(banquets, "banquet");
        addSlots(addons, "addon");

        const products = (await kvGetSafe("products", [])) || [];
        addSlots(products, "catalog");

        const cats = await getCatalogCategoriesSafe();
        for (const c of cats) {
          const cat = normalizeCat(c?.cat);
          if (cat === "catalog") continue;
          const key = catalogItemsKeyForCat(cat);
          const list = (await kvGetSafe(key, [])) || [];
          addSlots(list, `catalog:${cat}`);
        }

        return REQ_OK(res, { requestId, years, slots });
      }

      if (type === "years_index") {
        const years = await listIndexedYears();
        return REQ_OK(res, { requestId, years });
      }

      if (type === "year_summary") {
        const yParam = url.searchParams.get("year");
        const year = Number(yParam);
        if (!Number.isFinite(year)) {
          return REQ_ERR(res, 400, "invalid-year", { requestId, year: yParam });
        }
        const summary = await getYearSummary(year);
        return REQ_OK(res, { requestId, ...summary });
      }

      if (type === "year_multi") {
        let yearsParams = url.searchParams.getAll("year");
        if (!yearsParams.length) {
          const csv = url.searchParams.get("years") || "";
          if (csv) {
            yearsParams = csv
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }

        const years = yearsParams
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);

        if (!years.length) {
          const allYears = await listIndexedYears();
          return REQ_OK(res, { requestId, years: allYears, points: [], raw: [] });
        }

        const raw = await getMultiYearSummary(years);

        const points = raw.map((r) => ({
          year: r.year,
          totalOrders: r.totalOrders || 0,
          uniqueBuyers: r.uniqueBuyers || 0,
          repeatBuyers: r.repeatBuyers || 0,
          totalPeople: r.totalPeople || 0,
          totalCents: r.totalCents || 0,
        }));

        return REQ_OK(res, { requestId, years, points, raw });
      }

      if (type === "catalog_categories") {
        const categories = await getCatalogCategoriesSafe();
        return REQ_OK(res, { requestId, categories });
      }

      if (type === "catalog_items") {
        const cat = normalizeCat(url.searchParams.get("cat") || "catalog");
        const key = catalogItemsKeyForCat(cat);
        const items = (await kvGetSafe(key, [])) || [];
        return REQ_OK(res, { requestId, cat, items });
      }

      if (type === "catalog_has_active") {
        const cat = normalizeCat(url.searchParams.get("cat") || "catalog");
        const key = catalogItemsKeyForCat(cat);
        const items = (await kvGetSafe(key, [])) || [];
        const hasActive =
          Array.isArray(items) && items.some((it) => it && it.active);
        return REQ_OK(res, { requestId, cat, hasActive });
      }

      if (type === "catalog_items_yoy") {
        const cat = normalizeCat(url.searchParams.get("cat") || "catalog");

        let yearsParams = url.searchParams.getAll("year");
        if (!yearsParams.length) {
          const csv = url.searchParams.get("years") || "";
          if (csv)
            yearsParams = csv
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        }

        const years = yearsParams
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);

        const useYears = years.length ? years : await listIndexedYears();

        const key = catalogItemsKeyForCat(cat);
        const items = (await kvGetSafe(key, [])) || [];

        const byYear = {};
        for (const y of useYears) byYear[String(y)] = items;

        return REQ_OK(res, { requestId, cat, years: useYears, byYear });
      }

      if (type === "banquets")
        return REQ_OK(res, {
          requestId,
          banquets: (await kvGetSafe("banquets")) || [],
        });
      if (type === "addons")
        return REQ_OK(res, {
          requestId,
          addons: (await kvGetSafe("addons")) || [],
        });
      if (type === "products")
        return REQ_OK(res, {
          requestId,
          products: (await kvGetSafe("products")) || [],
        });

      if (type === "settings") {
        const { env, overrides, effective } = await getEffectiveSettings();
        const lockdown = await getLockdownStateSafe().catch(() => ({
          on: false,
          message: "",
          updatedAt: "",
        }));
        return REQ_OK(res, {
          requestId,
          env,
          overrides,
          effective,
          MAINTENANCE_ON: effective.MAINTENANCE_ON,
          MAINTENANCE_MESSAGE:
            effective.MAINTENANCE_MESSAGE || env.MAINTENANCE_MESSAGE,
          lockdown,
        });
      }

      if (type === "feature_flags") {
        if (!(await requireAdminAuth(req, res))) return;

        const { flags, updatedAt } = await loadFeatureFlagsSafe();
        return REQ_OK(res, { requestId, flags, updatedAt });
      }

      // ✅ Receipts ZIP endpoints (admin-only)
      if (type === "receipts_zip_month") {
        if (!(await requireAdminAuth(req, res))) return;

        try {
          const to = String(url.searchParams.get("to") || "").trim(); // optional; core.js may default
          const yearParam = url.searchParams.get("year");
          const monthParam = url.searchParams.get("month");

          const now = new Date();
          const year = Number(yearParam ?? now.getUTCFullYear());
          const month = Number(monthParam ?? (now.getUTCMonth() + 1)); // 1-12

          const result = await emailMonthlyReceiptsZip({
            to: to || undefined,
            year,
            month,
            requestId,
          });

          if (result && result.ok) return REQ_OK(res, { requestId, ...result });
          return REQ_ERR(res, 500, (result && result.error) || "zip-send-failed", {
            requestId,
            ...(result || {}),
          });
        } catch (e) {
          return errResponse(res, 500, "receipts-zip-month-failed", req, e);
        }
      }

      if (type === "receipts_zip_final") {
        if (!(await requireAdminAuth(req, res))) return;

        try {
          const to = String(url.searchParams.get("to") || "").trim(); // optional; core.js may default
          const yearParam = url.searchParams.get("year");

          const now = new Date();
          const year = Number(yearParam ?? now.getUTCFullYear());

          const result = await emailFinalReceiptsZip({
            to: to || undefined,
            year,
            requestId,
          });

          if (result && result.ok) return REQ_OK(res, { requestId, ...result });
          return REQ_ERR(res, 500, (result && result.error) || "zip-send-failed", {
            requestId,
            ...(result || {}),
          });
        } catch (e) {
          return errResponse(res, 500, "receipts-zip-final-failed", req, e);
        }
      }

      // helper: sends the *previous* month ZIP (useful for cron)
      if (type === "receipts_zip_month_auto") {
        if (!(await requireAdminAuth(req, res))) return;

        try {
          const to = String(url.searchParams.get("to") || "").trim(); // optional
          const now = new Date();

          // previous month in UTC
          let y = now.getUTCFullYear();
          let m = now.getUTCMonth() + 1; // 1-12 current
          m -= 1;
          if (m <= 0) {
            m = 12;
            y -= 1;
          }

          const result = await emailMonthlyReceiptsZip({
            to: to || undefined,
            year: y,
            month: m,
            requestId,
            auto: true,
          });

          if (result && result.ok) return REQ_OK(res, { requestId, ...result });
          return REQ_ERR(res, 500, (result && result.error) || "zip-send-failed", {
            requestId,
            ...(result || {}),
          });
        } catch (e) {
          return errResponse(res, 500, "receipts-zip-auto-failed", req, e);
        }
      }

      if (type === "checkout_mode") {
        const nowMs = Date.now();
        const raw = await getCheckoutSettingsAuto(new Date(nowMs));
        const effectiveChannel = await getEffectiveOrderChannel(new Date(nowMs));

        const startMs = raw.liveStart ? Date.parse(raw.liveStart) : NaN;
        const endMs = raw.liveEnd ? Date.parse(raw.liveEnd) : NaN;
        const windowActive =
          !isNaN(startMs) &&
          nowMs >= startMs &&
          (isNaN(endMs) || nowMs <= endMs);

        return REQ_OK(res, {
          requestId,
          raw,
          auto: { now: new Date(nowMs).toISOString(), windowActive },
          effectiveChannel,
        });
      }

      if (type === "stripe_pubkey" || type === "stripe_pk") {
        const mode = await getEffectiveOrderChannel().catch(() => "test");
        return REQ_OK(res, {
          requestId,
          publishableKey: getStripePublishableKey(mode),
          mode,
        });
      }

      if (type === "checkout_session") {
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) return REQ_ERR(res, 400, "missing-id", { requestId });

        const inferred = inferStripeEnvFromCheckoutSessionId(id);

        let primaryEnv = inferred;
        if (!primaryEnv) {
          const eff = await getEffectiveOrderChannel().catch(() => "test");
          primaryEnv = eff === "live" || eff === "live_test" ? "live" : "test";
        }
        const fallbackEnv = primaryEnv === "live" ? "test" : "live";

        const stripePrimary = await getStripe(primaryEnv);
        const stripeFallback = await getStripe(fallbackEnv);

        const tryRetrieve = async (stripeClient) => {
          if (!stripeClient) return null;
          return stripeClient.checkout.sessions.retrieve(id, {
            expand: ["payment_intent"],
          });
        };

        let s = null;
        let usedEnv = primaryEnv;

        try {
          s = await tryRetrieve(stripePrimary);
          usedEnv = primaryEnv;
        } catch {}

        if (!s) {
          try {
            s = await tryRetrieve(stripeFallback);
            usedEnv = fallbackEnv;
          } catch {}
        }

        if (!s)
          return REQ_ERR(res, 404, "checkout-session-not-found", {
            requestId,
            id,
          });

        return REQ_OK(res, {
          requestId,
          env: usedEnv,
          id: s.id,
          amount_total: s.amount_total,
          currency: s.currency,
          customer_details: s.customer_details || {},
          payment_intent:
            typeof s.payment_intent === "string"
              ? s.payment_intent
              : s.payment_intent?.id,
        });
      }

      // (orders + csv endpoints unchanged)
      if (type === "orders") {
        const ids = await kvSmembersSafe("orders:index");
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
        }

        const daysParam = url.searchParams.get("days");
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");

        const { effective } = await getEffectiveSettings();
        const cfgDays = Number(effective.REPORT_ORDER_DAYS || 0) || 0;
        const cfgStart = effective.EVENT_START || "";
        const cfgEnd = effective.EVENT_END || "";

        let startMs = NaN;
        let endMs = NaN;

        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs = parseYMD(endParam);
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs =
              endMs - Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
          } else {
            startMs = parseYMD(cfgStart);
            endMs = parseYMD(cfgEnd);
          }
        }

        let rows = all;
        if (!isNaN(startMs) || !isNaN(endMs)) {
          rows = filterRowsByWindow(rows, {
            startMs: isNaN(startMs) ? undefined : startMs,
            endMs: isNaN(endMs) ? undefined : endMs,
          });
        }

        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (q) {
          rows = rows.filter(
            (r) =>
              String(r.purchaser || "").toLowerCase().includes(q) ||
              String(r.attendee || "").toLowerCase().includes(q) ||
              String(r.item || "").toLowerCase().includes(q) ||
              String(r.category || "").toLowerCase().includes(q) ||
              String(r.status || "").toLowerCase().includes(q) ||
              String(r.notes || "").toLowerCase().includes(q)
          );
        }

        const catParam = (url.searchParams.get("category") || "").toLowerCase();
        const itemIdParam = (url.searchParams.get("item_id") || "").toLowerCase();
        const itemParam = (url.searchParams.get("item") || "").toLowerCase();

        if (catParam) {
          rows = rows.filter(
            (r) => String(r.category || "").toLowerCase() === catParam
          );
        }

        if (itemIdParam) {
          const wantRaw = itemIdParam;
          const wantBase = baseKey(wantRaw);
          const wantNorm = normalizeKey(wantRaw);
          rows = rows.filter((r) => {
            const raw = String(r._itemId || r.item_id || "").toLowerCase();
            const rawNorm = normalizeKey(raw);
            const keyBase = baseKey(raw);
            const rowBase = r._itemBase || keyBase;
            return (
              raw === wantRaw ||
              rawNorm === wantNorm ||
              keyBase === wantBase ||
              rowBase === wantBase ||
              String(r._itemKey || "").toLowerCase() === wantNorm
            );
          });
        } else if (itemParam) {
          const want = itemParam;
          rows = rows.filter((r) =>
            String(r.item || "").toLowerCase().includes(want)
          );
        }

        rows = sortByDateAsc(rows, "date");
        return REQ_OK(res, { requestId, rows });
      }

            if (type === "orders_csv") {
        // Download-safe XLSX export (null-safe + empty-safe)
        const ids = await kvSmembersSafe("orders:index");
        const all = [];

        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (!o) continue;

          const rows = flattenOrderToRows(o) || [];
          if (Array.isArray(rows)) {
            for (const r of rows) {
              if (r && typeof r === "object") all.push(r);
            }
          }
        }

        const daysParam = url.searchParams.get("days");
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");

        const { effective } = await getEffectiveSettings();
        const cfgDays = Number(effective.REPORT_ORDER_DAYS || 0) || 0;
        const cfgStart = effective.EVENT_START || "";
        const cfgEnd = effective.EVENT_END || "";

        let startMs = NaN;
        let endMs = NaN;

        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs = parseYMD(endParam);
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs = endMs - Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
          } else {
            startMs = parseYMD(cfgStart);
            endMs = parseYMD(cfgEnd);
          }
        }

        let rows = all;

        if (!isNaN(startMs) || !isNaN(endMs)) {
          rows = filterRowsByWindow(rows, {
            startMs: isNaN(startMs) ? undefined : startMs,
            endMs: isNaN(endMs) ? undefined : endMs,
          });
        }

        const qSearch = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (qSearch) {
          rows = rows.filter(
            (r) =>
              String(r.purchaser || "").toLowerCase().includes(qSearch) ||
              String(r.attendee || "").toLowerCase().includes(qSearch) ||
              String(r.item || "").toLowerCase().includes(qSearch) ||
              String(r.category || "").toLowerCase().includes(qSearch) ||
              String(r.status || "").toLowerCase().includes(qSearch) ||
              String(r.notes || "").toLowerCase().includes(qSearch)
          );
        }

        const catParam = (url.searchParams.get("category") || "").toLowerCase();
        const itemIdParam = (url.searchParams.get("item_id") || "").toLowerCase();
        const itemParam = (url.searchParams.get("item") || "").toLowerCase();

        if (catParam) {
          rows = rows.filter((r) => String(r.category || "").toLowerCase() === catParam);
        }

        if (itemIdParam) {
          const wantRaw = itemIdParam;
          const wantBase = baseKey(wantRaw);
          const wantNorm = normalizeKey(wantRaw);

          rows = rows.filter((r) => {
            if (!r || typeof r !== "object") return false;
            const raw = String(r._itemId || r.item_id || "").toLowerCase();
            const rawNorm = normalizeKey(raw);
            const keyBase = baseKey(raw);
            const rowBase = r._itemBase || keyBase;
            return (
              raw === wantRaw ||
              rawNorm === wantNorm ||
              keyBase === wantBase ||
              rowBase === wantBase ||
              String(r._itemKey || "").toLowerCase() === wantNorm
            );
          });
        } else if (itemParam) {
          const want = itemParam;
          rows = rows.filter((r) => String(r.item || "").toLowerCase().includes(want));
        }

        // --- XLSX safety: remove nulls + coerce cell values to primitives ---
        const safeRows = (Array.isArray(rows) ? rows : [])
          .filter((r) => r && typeof r === "object")
          .map((r) => {
            const out = {};
            for (const [k, v] of Object.entries(r)) {
              if (v === null || v === undefined) out[k] = "";
              else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
              else if (typeof v === "bigint") out[k] = v.toString();
              else if (v instanceof Date) out[k] = v.toISOString();
              else {
                try { out[k] = JSON.stringify(v); } catch { out[k] = String(v); }
              }
            }
            return out;
          });

        const sorted = sortByDateAsc(safeRows, "date").filter(
          (r) => r && typeof r === "object"
        );

        const fallback = {
          id: "",
          date: "",
          purchaser: "",
          attendee: "",
          category: "",
          item: "",
          item_id: "",
          qty: 0,
          price: 0,
          gross: 0,
          fees: 0,
          net: 0,
          status: "",
          notes: "",
          _itemId: "",
          _itemBase: "",
          _itemKey: "",
          _pi: "",
          _charge: "",
          _session: "",
          mode: "",
        };

        const useRows = sorted.length ? sorted : [fallback];
        const headers = Object.keys(useRows[0] || fallback);

        let buf;
        try {
          // core.js objectsToXlsxBuffer may internally map over a "column specs" array and
          // assume each entry is a non-null object (e.g., spec.id). Passing [] keeps it safe.
          buf = await objectsToXlsxBuffer(headers, useRows, [], "Orders");
        } catch (e) {
          console.error("orders_csv: failed to build XLSX (safe)", e);
          // Fallback: try with a single fallback row only
          buf = await objectsToXlsxBuffer(Object.keys(fallback), [fallback], [], "Orders");
        }

        const fileParts = [];
        if (catParam) fileParts.push(catParam);
        if (itemIdParam) fileParts.push(itemIdParam);
        const fname = (fileParts.join("-") || "orders") + ".xlsx";

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        return res.status(200).send(buf);
      }

      if (type === "attendee_roster_csv") {
        const ids = await kvSmembersSafe("orders:index");
        const orders = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) orders.push(o);
        }

        const daysParam = url.searchParams.get("days");
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        let startMs = NaN,
          endMs = NaN;
        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs = parseYMD(endParam);
        }

        const cats = (url.searchParams.get("category") || "banquet,addon")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const roster = collectAttendeesFromOrders(orders, {
          includeAddress: false,
          categories: cats,
          startMs: isNaN(startMs) ? undefined : startMs,
          endMs: isNaN(endMs) ? undefined : endMs,
        });

        const sorted = sortByDateAsc(roster, "date").filter(
          (r) => r && typeof r === "object"
        );
        const headers = [
          "date",
          "purchaser",
          "attendee",
          "attendee_title",
          "attendee_phone",
          "attendee_email",
          "item",
          "item_id",
          "qty",
          "notes",
        ];

        const buf = await objectsToXlsxBuffer(headers, sorted, [], "Attendees");
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="attendee-roster.xlsx"`
        );
        return res.status(200).send(buf);
      }

      if (type === "directory_csv") {
        const ids = await kvSmembersSafe("orders:index");
        const orders = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) orders.push(o);
        }

        const daysParam = url.searchParams.get("days");
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        let startMs = NaN,
          endMs = NaN;
        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs = parseYMD(endParam);
        }

        const cats = (url.searchParams.get("category") || "banquet,addon")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const roster = collectAttendeesFromOrders(orders, {
          includeAddress: true,
          categories: cats,
          startMs: isNaN(startMs) ? undefined : startMs,
          endMs: isNaN(endMs) ? undefined : endMs,
        });

        const sorted = sortByDateAsc(roster, "date").filter(
          (r) => r && typeof r === "object"
        );
        const headers = [
          "attendee",
          "attendee_title",
          "attendee_email",
          "attendee_phone",
          "attendee_addr1",
          "attendee_addr2",
          "attendee_city",
          "attendee_state",
          "attendee_postal",
          "attendee_country",
          "item",
          "qty",
          "notes",
          "purchaser",
          "date",
        ];

        const buf = await objectsToXlsxBuffer(headers, sorted, [], "Directory");
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="directory.xlsx"`);
        return res.status(200).send(buf);
      }

      if (type === "full_attendees_csv") {
        const ids = await kvSmembersSafe("orders:index");
        const orders = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) orders.push(o);
        }

        const daysParam = url.searchParams.get("days");
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        let startMs = NaN,
          endMs = NaN;
        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs = parseYMD(endParam);
        }

        const cats = (url.searchParams.get("category") || "banquet,addon")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const rosterAll = collectAttendeesFromOrders(orders, {
          includeAddress: true,
          categories: cats,
          startMs: isNaN(startMs) ? undefined : startMs,
          endMs: isNaN(endMs) ? undefined : endMs,
        });

        const withAttendee = rosterAll.filter(
          (r) => String(r.attendee || "").trim().length > 0
        );

        const norm = (s) => String(s || "").trim().toLowerCase();
        const normPhone = (s) => String(s || "").replace(/\D+/g, "");
        const map = new Map();
        for (const r of withAttendee) {
          const key = `${norm(r.attendee)}|${norm(r.attendee_email)}|${normPhone(
            r.attendee_phone
          )}`;
          const prev = map.get(key);
          if (!prev) map.set(key, r);
          else {
            const tPrev = parseDateISO(prev.date);
            const tNew = parseDateISO(r.date);
            if (!isNaN(tNew) && !isNaN(tPrev) && tNew < tPrev) {
              map.set(key, r);
            }
          }
        }

        const unique = sortByDateAsc(Array.from(map.values()), "date").filter(
          (r) => r && typeof r === "object"
        );

        const headers = [
          "#",
          "date",
          "attendee",
          "attendee_title",
          "attendee_phone",
          "attendee_email",
          "attendee_addr1",
          "attendee_addr2",
          "attendee_city",
          "attendee_state",
          "attendee_postal",
          "attendee_country",
        ];
        const numbered = unique.map((r, idx) => ({
          "#": idx + 1,
          date: r.date,
          attendee: r.attendee,
          attendee_title: r.attendee_title,
          attendee_phone: r.attendee_phone,
          attendee_email: r.attendee_email,
          attendee_addr1: r.attendee_addr1,
          attendee_addr2: r.attendee_addr2,
          attendee_city: r.attendee_city,
          attendee_state: r.attendee_state,
          attendee_postal: r.attendee_postal,
          attendee_country: r.attendee_country,
        }));

        const buf = await objectsToXlsxBuffer(
          headers,
          numbered,
          [],
          "Full Attendees"
        );
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="full-attendees.xlsx"`
        );
        return res.status(200).send(buf);
      }

      // ✅ finalize_order now writes hash markers + sends receipts + realtime chair emails immediately
      if (type === "finalize_order") {
        const sid = String(url.searchParams.get("sid") || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid", { requestId });

        try {
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");
          const order = await saveOrderFromSession(
            { id: sid },
            { mode: orderChannel }
          );

          // ✅ write-once createdAt + hash (tamper detection)
          await ensureOrderIntegrityMarkers(order, requestId);

          // 🔥 Immediate: buyer receipts + chair emails + admin copy
          await sendPostOrderEmails(order, requestId);

          return REQ_OK(res, {
            requestId,
            ok: true,
            orderId: order.id,
            status: order.status || "paid",
          });
        } catch (err) {
          return errResponse(res, 500, "finalize-failed", req, err, { sid });
        }
      }

      if (type === "order") {
        const oid = String(url.searchParams.get("oid") || "").trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid", { requestId });
        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found", { requestId });
        return REQ_OK(res, { requestId, order });
      }

      
      // ✅ HTML receipt (same formatter as the emailed receipt) — for success.html
      if (type === "order_receipt_html") {
        const oid =
          String(url.searchParams.get("oid") || url.searchParams.get("sid") || "")
            .trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid", { requestId });

        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found", { requestId });

        // renderOrderEmailHTML already knows how to format attendees + notes.
        const html = await renderOrderEmailHTML(order);
        return REQ_OK(res, { requestId, html: html || "" });
      }

// --------------------------------------------------------------------
      // ✅ Compatibility: allow GET /api/router?type=send_item_report&... for testing
      // - If dryRun=1, returns a preview (no email sent) and does NOT require auth.
      // - If dryRun is falsey, requires admin auth and will send the email.
      // --------------------------------------------------------------------
      if (type === "send_item_report") {
        const kind = String(url.searchParams.get("kind") || "").trim().toLowerCase();
        const id = String(url.searchParams.get("id") || "").trim();
        const label = String(url.searchParams.get("label") || "").trim();
        const scope = String(url.searchParams.get("scope") || "current-month").trim();
        const dryRun = coerceBool(url.searchParams.get("dryRun") || url.searchParams.get("dry_run") || "");

        if (!id) return REQ_ERR(res, 400, "missing-id", { requestId });

        // Dry-run: provide a safe preview (no email)
        if (dryRun) {
          try {
            // We reuse the existing preview helper. It uses itemcfg + orders to show
            // what *would* be sent, without sending anything.
            const out = await handleChairPreview({ id, scope });
            return REQ_OK(res, {
              requestId,
              ok: true,
              dryRun: true,
              kind: kind || (out?.kind || ""),
              id,
              label: label || out?.label || out?.name || "",
              scope,
              preview: out,
            });
          } catch (e) {
            return errResponse(res, 500, "send-item-report-dryrun-failed", req, e, {
              id,
              scope,
            });
          }
        }

        // Real send: admin-only + respects lockdown
        if (!(await requireAdminAuth(req, res))) return;
        if (!(await enforceLockdownIfNeeded(req, res, "send_item_report", requestId))) return;

        try {
          const result = await sendItemReportEmailInternal({ kind, id, label, scope });
          if (!result?.ok) {
            return REQ_ERR(res, 500, result?.error || "send-failed", {
              requestId,
              ...(result || {}),
            });
          }
          return REQ_OK(res, { requestId, ok: true, ...result });
        } catch (e) {
          return errResponse(res, 500, "send-item-report-failed", req, e, { kind, id, scope });
        }
      }
    } // ✅ IMPORTANT: this closes `if (req.method === "GET") { ... }`

    // ---------- POST ----------
    if (req.method === "POST") {
      let body = {};
      try {
        if (action !== "stripe_webhook") {
          body = await readJsonBody(req);
        }
      } catch (e) {
        return errResponse(res, 400, "invalid-json", req, e);
      }


      // ✅ Public: track a visit (no auth)
      if (action === "track_visit") {
        try {
          const pathParam =
            String(body?.path || body?.pathname || "") ||
            String(url.searchParams.get("path") || url.searchParams.get("p") || "");
          const fallbackPath = url.pathname || "/";
          const mode = await getEffectiveOrderChannel().catch(() => "test");
          const vidParam =
            String(body?.vid || body?.visitorId || body?.v || "") ||
            String(url.searchParams.get("vid") || url.searchParams.get("visitorId") || url.searchParams.get("v") || "");
          const out = await trackVisitInternal({
            path: pathParam || fallbackPath,
            mode,
            now: new Date(),
            vid: vidParam,
          });
          return REQ_OK(res, { requestId, ...out });
        } catch (e) {
          return errResponse(res, 500, "track-visit-failed", req, e);
        }
      }

      if (action === "admin_login") {
        try {
          const ip =
            req.headers["x-forwarded-for"] ||
            req.headers["x-real-ip"] ||
            req.socket?.remoteAddress ||
            "";
          const ua = req.headers["user-agent"] || "";

          console.log("[router] admin_login called", { ip, ua, hasBody: !!body });

          const result = await handleAdminLogin({
            password: String(body.password || ""),
            ip,
            userAgent: ua,
          });

          console.log("[router] admin_login result", result);

          if (result.ok) return REQ_OK(res, { requestId, ...result });

          const status =
            result.error === "invalid_password" || result.error === "locked_out"
              ? 401
              : 500;

          const errCode = result.error || "login-failed";
          return REQ_ERR(res, status, errCode, { requestId, ...result });
        } catch (e) {
          return errResponse(res, 500, "login-failed", req, e);
        }
      }

      if (action === "test_resend") {
        if (!resend)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });
        const urlObj = getUrl(req);
        const bodyTo = (body && body.to) || urlObj.searchParams.get("to") || "";
        const fallbackAdmin =
          (process.env.REPORTS_BCC || process.env.REPORTS_CC || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)[0] || "";
        const to = (bodyTo || fallbackAdmin).trim();
        if (!to) return REQ_ERR(res, 400, "missing-to", { requestId });

        const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
          <h2>Resend test OK</h2>
          <p>Time: ${new Date().toISOString()}</p>
          <p>From: ${RESEND_FROM || ""}</p>
          <p>requestId: ${String(requestId).replace(/</g, "&lt;")}</p>
        </div>`;

        const payload = {
          from: RESEND_FROM || "onboarding@resend.dev",
          to: [to],
          subject: "Amaranth test email",
          html,
          reply_to: REPLY_TO || undefined,
        };

        const retry = await sendWithRetry(
          () => resend.emails.send(payload),
          "manual-test"
        );

        if (retry.ok) {
          const sendResult = retry.result;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [to],
            subject: payload.subject,
            resultId: sendResult?.id || null,
            kind: "manual-test",
            status: "queued",
          });
          return REQ_OK(res, {
            requestId,
            ok: true,
            id: sendResult?.id || null,
            to,
          });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [to],
            subject: payload.subject,
            resultId: null,
            kind: "manual-test",
            status: "error",
            error: String(err?.message || err),
          });
          return errResponse(res, 500, "resend-send-failed", req, err);
        }
      }

      if (action === "contact_form") {
        if (!resend && !CONTACT_TO)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });

        const {
          name = "",
          email = "",
          phone = "",
          topic = "",
          page = "",
          item = "",
          message: msg = "",
        } = body || {};

        const missing = [];
        if (!String(name).trim()) missing.push("name");
        if (!String(email).trim()) missing.push("email");
        if (!String(topic).trim()) missing.push("topic");
        if (!String(msg).trim()) missing.push("message");
        if (missing.length)
          return REQ_ERR(res, 400, "missing-fields", { requestId, missing });

        const topicMap = {
          banquets: "Banquets / meal choices",
          addons: "Grand Court add-ons (directory, love gifts, etc.)",
          catalog: "Product catalog / merchandise items",
          order: "Order / checkout issues",
          website: "Website or technical problem",
          general: "General question",
        };
        const pageMap = {
          home: "Home",
          banquet: "Banquets page",
          addons: "Grand Court Add-Ons page",
          catalog: "Product Catalog page",
          order: "Order page",
        };

        const topicLabel =
          topicMap[String(topic).toLowerCase()] ||
          String(topic) ||
          "General question";
        const pageLabel = pageMap[String(page).toLowerCase()] || String(page) || "";

        const esc = (s) => String(s ?? "").replace(/</g, "&lt;");
        const safe = (s) => String(s || "").trim();

        const createdIso = new Date().toISOString();
        const ua = req.headers["user-agent"] || "";
        const ip =
          req.headers["x-forwarded-for"] ||
          req.headers["x-real-ip"] ||
          req.socket?.remoteAddress ||
          "";

        const html = `
          <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
            <h2 style="margin-bottom:4px;">Website Contact Form</h2>
            <p style="margin:2px 0;">Time (UTC): ${esc(createdIso)}</p>
            <p style="margin:2px 0;">Topic: <b>${esc(topicLabel)}</b></p>
            ${pageLabel ? `<p style="margin:2px 0;">Page: <b>${esc(pageLabel)}</b></p>` : ""}
            <p style="margin:2px 0;font-size:12px;color:#555;">requestId: ${esc(
              requestId
            )}</p>
            <table style="border-collapse:collapse;border:1px solid #ccc;margin-top:10px;font-size:13px;">
              <tbody>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Name</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(name)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Email</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(email)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Phone</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(phone)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Topic</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(topicLabel)}</td>
                </tr>
                ${pageLabel ? `<tr><th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Page</th><td style="padding:4px 6px;border:1px solid #ddd;">${esc(pageLabel)}</td></tr>` : ""}
                ${item ? `<tr><th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Item</th><td style="padding:4px 6px;border:1px solid #ddd;">${esc(item)}</td></tr>` : ""}
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;vertical-align:top;">Message</th>
                  <td style="padding:6px 8px;border:1px solid #ddd;white-space:pre-wrap;">${esc(
                    msg
                  )}</td>
                </tr>
              </tbody>
            </table>
            <p style="margin-top:10px;font-size:12px;color:#555;">
              Technical details: IP=${esc(ip)} · User-Agent=${esc(ua)}
            </p>
          </div>
        `;

        const { effective } = await getEffectiveSettings();
        const split = (val) =>
          String(val || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        const toList = [CONTACT_TO].filter(Boolean);
        const adminBccBase = split(
          effective.REPORTS_BCC ||
            effective.REPORTS_CC ||
            process.env.REPORTS_BCC ||
            process.env.REPORTS_CC ||
            ""
        );
        const senderEmail = safe(email).toLowerCase();
        const bccList = adminBccBase.filter(
          (addr) => !toList.includes(addr) && addr.toLowerCase() !== senderEmail
        );

        if (!toList.length && !bccList.length)
          return REQ_ERR(res, 500, "no-recipient", { requestId });
        if (!resend)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });

        const subject = `Website contact — ${topicLabel}`;

        const payload = {
          from: RESEND_FROM || "onboarding@resend.dev",
          to: toList.length ? toList : bccList,
          bcc: toList.length && bccList.length ? bccList : undefined,
          subject,
          html,
          reply_to: senderEmail || REPLY_TO || undefined,
        };

        const retry = await sendWithRetry(
          () => resend.emails.send(payload),
          "contact-form"
        );

        if (retry.ok) {
          const sendResult = retry.result;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "queued",
            resultId: sendResult?.id || null,
          });
          return REQ_OK(res, { requestId, ok: true });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "error",
            error: String(err?.message || err),
          });
          return errResponse(res, 500, "contact-send-failed", req, err);
        }
      }

      // ✅ finalize_checkout now writes hash markers + sends receipts + realtime chair emails immediately
      if (action === "finalize_checkout") {
        try {
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");

          // ✅ FIX: use the correct Stripe client for the current order channel
          const stripe = await getStripe(orderChannel);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          const sid = String(body.sid || body.id || "").trim();
          if (!sid) return REQ_ERR(res, 400, "missing-sid", { requestId });

          const order = await saveOrderFromSession({ id: sid }, { mode: orderChannel });

          // ✅ write-once createdAt + hash (tamper detection)
          await ensureOrderIntegrityMarkers(order, requestId);

          // 🔥 Immediate: buyer receipts + chair emails + admin copy
          await sendPostOrderEmails(order, requestId);

          return REQ_OK(res, { requestId, ok: true, orderId: order.id });
        } catch (e) {
          return errResponse(res, 500, "finalize-checkout-failed", req, e);
        }
      }

      if (action === "send_item_report") {
        try {
          const kind = String(body?.kind || body?.category || "").toLowerCase();
          const id = String(body?.id || "").trim();
          const label = String(body?.label || "").trim();
          const scope = String(body?.scope || "current-month");
          const result = await sendItemReportEmailInternal({ kind, id, label, scope });
          if (!result.ok)
            return REQ_ERR(res, 500, result.error || "send-failed", {
              requestId,
              ...result,
            });
          return REQ_OK(res, { requestId, ok: true, ...result });
        } catch (e) {
          return errResponse(res, 500, "send-item-report-failed", req, e);
        }
      }

      if (action === "create_checkout_session") {
        try {
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");

          const stripe = await getStripe(orderChannel);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          const origin = req.headers.origin || `https://${req.headers.host}`;
          const successUrl =
            (body.success_url || `${origin}/success.html`) +
            `?sid={CHECKOUT_SESSION_ID}`;
          const cancelUrl = body.cancel_url || `${origin}/order.html`;

          if (Array.isArray(body.lines) && body.lines.length) {
            const lines = body.lines;
            const fees = body.fees || { pct: 0, flat: 0 };
            const purchaser = body.purchaser || {};

            const line_items = lines.map((l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle =
                priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;

              const unit_amount = isBundle
                ? cents(l.bundleTotalCents)
                : toCentsAuto(l.unitPrice || 0);
              const quantity = isBundle ? 1 : Math.max(1, Number(l.qty || 1));

              // ✅ Love Gift / variable donation: include per-person amount in the item name
              // so chair/realtime emails that only show itemName still include the dollar amount.
              let displayName = String(l.itemName || "Item");
              try {
                const id = String(l.itemId || "").trim().toLowerCase();
                const t = String(l.itemType || "").trim().toLowerCase();
                const looksLikeLoveGift =
                  id === "love_gift" ||
                  id === "lovegift" ||
                  id.includes("love_gift") ||
                  id.includes("lovegift") ||
                  (t === "addon" && displayName.toLowerCase().includes("love gift")) ||
                  displayName.toLowerCase().includes("love gift");
                if (looksLikeLoveGift && Number.isFinite(unit_amount)) {
                  const amt = (Number(unit_amount) / 100).toFixed(2);
                  // Avoid double-appending if already present
                  if (!displayName.includes("$")) displayName = `${displayName} — $${amt}`;
                }
              } catch {}
              // ✅ Corsage variants: keep separate line items & show choice/note on Order page + receipts
              // We DO NOT change itemId (so chair email routing still works), but we make the Stripe product
              // name unique per variant so your UI can show "Rose Corsage" vs "Custom Corsage — note..."
              try {
                const id2 = String(l.itemId || "").trim().toLowerCase();
                const name2 = String(displayName || "").toLowerCase();
                const looksLikeCorsage =
                  id2 === "corsage" ||
                  id2 === "corsages" ||
                  id2.includes("corsage") ||
                  name2.includes("corsage");

                if (looksLikeCorsage) {
                  const choice =
                    String(
                      l?.meta?.corsageChoice ??
                        l?.meta?.corsage_choice ??
                        l?.meta?.corsageType ??
                        l?.meta?.corsage_type ??
                        l?.meta?.choice ??
                        l?.meta?.selection ??
                        l?.meta?.style ??
                        l?.meta?.color ??
                        ""
                    ).trim();

                  const wearRaw =
                    String(
                      l?.meta?.corsageWear ??
                        l?.meta?.corsage_wear ??
                        l?.meta?.wear ??
                        l?.meta?.wearStyle ??
                        l?.meta?.wear_style ??
                        l?.meta?.attachment ??
                        ""
                    ).trim();
                  const wearLower = wearRaw.toLowerCase();
                  const wearLabel =
                    wearLower === "wrist" || wearLower === "w"
                      ? "Wrist"
                      : wearLower === "pin" ||
                        wearLower === "pin-on" ||
                        wearLower === "pin on" ||
                        wearLower === "p"
                      ? "Pin-on"
                      : wearRaw;

                  const noteRaw =
                    String(
                      l?.meta?.itemNote ||
                        l?.meta?.item_note ||
                        l?.meta?.notes ||
                        l?.meta?.note ||
                        l?.meta?.message ||
                        l?.itemNote ||
                        l?.item_note ||
                        l?.notes ||
                        l?.note ||
                        l?.message ||
                        ""
                    ).trim();

                  if (choice) {
                    const lowerChoice = choice.toLowerCase();
                    // Avoid double-appending
                    if (!name2.includes(lowerChoice)) displayName = `${displayName} (${choice})`;
                  }

                  
                  if (wearLabel) {
                    const wl = String(wearLabel).toLowerCase();
                    // Avoid double-appending
                    if (!String(displayName).toLowerCase().includes(wl)) {
                      // If we already added choice as "(...)", prefer "(Choice, Wear)"
                      const m = String(displayName).match(/^(.*)\(([^)]*)\)\s*$/);
                      if (m && m[2] && !m[2].toLowerCase().includes(wl)) {
                        displayName = `${m[1]}(${m[2]}, ${wearLabel})`;
                      } else {
                        displayName = `${displayName} (${wearLabel})`;
                      }
                    }
                  }
// If it's custom, or they typed a note, include it in the displayed name (trimmed)
                  if (noteRaw) {
                    const shortNote = noteRaw.length > 90 ? noteRaw.slice(0, 87) + "…" : noteRaw;
                    if (!String(displayName).includes(shortNote)) displayName = `${displayName} — ${shortNote}`;
                  }
                }
              
                // Pre-Registration: include Voting / Non-Voting in the item name so it shows up in
                // - Stripe customer email receipts
                // - Our emailed receipt / success.html receipt
                // - Chair spreadsheets (deriveVotingStatus reads stored text)
                try {
                  const votingBool =
                    l?.meta?.isVoting ??
                    l?.meta?.votingBool ??
                    l?.meta?.voting_boolean ??
                    null;

                  const votingRaw =
                    l?.meta?.votingStatus ??
                    l?.meta?.voting_status ??
                    l?.meta?.voting ??
                    l?.meta?.votingType ??
                    l?.meta?.voting_type ??
                    l?.meta?.votingFlag ??
                    l?.meta?.voting_flag ??
                    "";

                  let votingLabel = "";
                  if (votingBool === true) votingLabel = "Voting";
                  else if (votingBool === false) votingLabel = "Non-Voting";
                  else {
                    const vr = String(votingRaw ?? "").trim().toLowerCase();
                    if (vr) {
                      if (/non\s*-?\s*voting/.test(vr) || /nonvoting/.test(vr) || vr === "nv") votingLabel = "Non-Voting";
                      else if (/\bvoting\b/.test(vr) || vr === "v") votingLabel = "Voting";
                      else if (["1", "true", "t", "yes", "y"].includes(vr)) votingLabel = "Voting";
                      else if (["0", "false", "f", "no", "n"].includes(vr)) votingLabel = "Non-Voting";
                    }
                  }

                  const isPreReg =
                    (id2.includes("pre") && (id2.includes("reg") || id2.includes("registration"))) ||
                    name2.includes("pre-registration") ||
                    name2.includes("pre registration") ||
                    name2.includes("pre reg") ||
                    name2.includes("prereg");

// Fallback: if the Order page already embedded "Voting"/"Non-Voting" in attendeeTitle/notes,
// reuse that for Stripe-visible names (Stripe does not display metadata on receipts).
if (isPreReg && !votingLabel) {
  const fromTitle = String(l?.meta?.attendeeTitle || "").toLowerCase();
  const fromNotes = String(l?.meta?.attendeeNotes || l?.meta?.attendeeNote || "").toLowerCase();
  const fromName  = String(displayName || "").toLowerCase();
  const blob = `${fromTitle} ${fromNotes} ${fromName}`.trim();
  if (blob) {
    if (blob.includes("non-voting") || blob.includes("nonvoting") || blob.includes("non voting") || /\bnv\b/.test(blob)) votingLabel = "Non-Voting";
    else if (blob.includes("voting") || /\bv\b/.test(blob)) votingLabel = "Voting";
  }
}


                  if (isPreReg && votingLabel) {
                    const dl = String(displayName || "").toLowerCase();
                    // Avoid double-appending
                    if (!dl.includes("non-voting") && !dl.includes("nonvoting") && !dl.includes("voting")) {
                      displayName = `${displayName} (${votingLabel})`;
                    }

                    // Also ensure it shows up like banquet notes in our receipt:
                    // put it into itemNote if no other notes exist.
                    try {
                      l.meta = l.meta || {};
                      const hasNotes =
                        !!(l.meta.itemNote || l.meta.item_note || l.meta.attendeeNotes || l.meta.dietaryNote);
                      if (!hasNotes) {
                        l.meta.itemNote = `Member: ${votingLabel}`;
                      }
                    } catch {}
                  }
                } catch {}
} catch {}


              return {
                quantity,
                price_data: {
                  currency: "usd",
                  unit_amount,
                  product_data: {
                    name: displayName,
                    metadata: {
                      itemId: l.itemId || "",
                      itemType: l.itemType || "",
                      attendeeId: l.attendeeId || "",
                      attendeeName: l.meta?.attendeeName || "",
                      attendeeTitle: l.meta?.attendeeTitle || "",
                      attendeePhone: l.meta?.attendeePhone || "",
                      attendeeEmail: l.meta?.attendeeEmail || "",
                      attendeeNotes: l.meta?.attendeeNotes || "",
                      dietaryNote: l.meta?.dietaryNote || "",
					  attendeeCourt:
                          (l.meta?.attendeeCourt ||
                          l.meta?.attendeeCourtName ||
                          l.meta?.attendee_court ||
                          l.meta?.attendee_court_name ||
                          l.meta?.court ||
                          l.meta?.courtName ||
                          l.meta?.court_name ||
                          ""),
                      attendeeCourtNumber:
                          (l.meta?.attendeeCourtNumber ||
                          l.meta?.attendeeCourtNo ||
                          l.meta?.attendeeCourtNum ||
                          l.meta?.attendee_court_number ||
                          l.meta?.attendee_court_no ||
                          l.meta?.attendee_court_num ||
                          l.meta?.courtNumber ||
                          l.meta?.court_no ||
                          l.meta?.courtNo ||
                          l.meta?.courtNum ||
                          ""),
                      votingStatus:
                        (l.meta?.votingStatus ||
                          l.meta?.voting_status ||
                          l.meta?.voting ||
                          l.meta?.votingType ||
                          l.meta?.voting_type ||
                          ""),
                      voting_status:
                        (l.meta?.votingStatus ||
                          l.meta?.voting_status ||
                          l.meta?.voting ||
                          l.meta?.votingType ||
                          l.meta?.voting_type ||
                          ""),
                      isVoting:
                        String(
                          l.meta?.isVoting ??
                            l.meta?.votingBool ??
                            l.meta?.voting_boolean ??
                            ""
                        ),

                      itemNote:
                        (l.meta?.itemNote ||
                          l.meta?.item_note ||
                          l.meta?.notes ||
                          l.meta?.note ||
                          l.meta?.message ||
                          l.itemNote ||
                          l.item_note ||
                          l.notes ||
                          l.note ||
                          l.message ||
                          "")
                        ,
                      corsageChoice:
                        (l.meta?.corsageChoice ||
                          l.meta?.corsage_choice ||
                          l.meta?.corsageType ||
                          l.meta?.corsage_type ||
                          l.meta?.choice ||
                          l.meta?.selection ||
                          l.meta?.style ||
                          l.meta?.color ||
                          ""),
                                            corsageWear:
                        (l.meta?.corsageWear ||
                          l.meta?.corsage_wear ||
                          l.meta?.wear ||
                          l.meta?.wearStyle ||
                          l.meta?.wear_style ||
                          l.meta?.attachment ||
                          ""),
corsageNote:
                        (l.meta?.itemNote ||
                          l.meta?.item_note ||
                          l.meta?.notes ||
                          l.meta?.note ||
                          l.meta?.message ||
                          l.itemNote ||
                          l.item_note ||
                          l.notes ||
                          l.note ||
                          l.message ||
                          ""),

                      attendeeAddr1: l.meta?.attendeeAddr1 || "",
                      attendeeAddr2: l.meta?.attendeeAddr2 || "",
                      attendeeCity: l.meta?.attendeeCity || "",
                      attendeeState: l.meta?.attendeeState || "",
                      attendeePostal: l.meta?.attendeePostal || "",
                      attendeeCountry: l.meta?.attendeeCountry || "",
                      priceMode: priceMode || "",
                      bundleQty: isBundle ? String(l.bundleQty || "") : "",
                      bundleTotalCents: isBundle ? String(unit_amount) : "",
                      loveGiftAmountCents: String(unit_amount),
                    },
                  },
                },
              };
            });

            const pct = Number(fees.pct || 0);
            const flatCents = toCentsAuto(fees.flat || 0);

            const subtotalCents = lines.reduce((s, l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle =
                priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;
              if (isBundle) return s + cents(l.bundleTotalCents || 0);
              return s + toCentsAuto(l.unitPrice || 0) * Number(l.qty || 0);
            }, 0);

            // Compute processing fee so that, after Stripe takes (pct% + flat), you net the base subtotal.
// IMPORTANT: Stripe charges its % on the entire amount collected (including the fee line),
// so we must "gross-up" instead of base*pct + flat.
const rate = (pct / 100);
const baseCentsForFee = subtotalCents; // subtotalCents already includes bundles/qty and should match your "base"
let feeAmount = 0;
if (baseCentsForFee > 0 && (rate > 0 || flatCents > 0) && rate < 1) {
  const grossCents = Math.ceil((baseCentsForFee + flatCents) / (1 - rate));
  feeAmount = Math.max(0, grossCents - baseCentsForFee);
}

if (feeAmount > 0) {
  line_items.push({
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: feeAmount,
      product_data: {
        name: "Online Processing Fee",
        metadata: { itemType: "fee", itemId: "processing-fee" },
      },
    },
  });
}

/** ✅ COUNTRY CODE FIX (only change in this block)
 * Normalizes common "United States" spellings to ISO-2 "US"
 * so you don't accidentally add the international 3% fee.
 */
function normalizeCountryCode2(raw) {
  const s = String(raw || "").trim();
  if (!s) return "US";

  const up = s.toUpperCase();

  // already ISO-2
  if (/^[A-Z]{2}$/.test(up)) return up;

  // common US variants
  if (
    up === "UNITED STATES" ||
    up === "UNITED STATES OF AMERICA" ||
    up === "U.S." ||
    up === "U.S.A." ||
    up === "USA" ||
    up === "AMERICA"
  ) {
    return "US";
  }

  // optional but safe
  if (up === "CANADA") return "CA";

  return up;
}

            const purchaserCountry = normalizeCountryCode2(
              purchaser.country || purchaser.addressCountry || "US"
            );
            const accountCountry = normalizeCountryCode2(
              process.env.STRIPE_ACCOUNT_COUNTRY || "US"
            );

            let intlFeeAmount = 0;
            if (isInternationalOrder(purchaserCountry, accountCountry)) {
              intlFeeAmount = computeInternationalFeeCents(subtotalCents, 0.03);
            }

            if (intlFeeAmount > 0) {
              const intlLine = buildInternationalFeeLineItem(intlFeeAmount, "usd");
              if (intlLine && intlLine.price_data?.product_data) {
                intlLine.price_data.product_data.name =
                  intlLine.price_data.product_data.name ||
                  "International Card Processing Fee (3%)";
                intlLine.price_data.product_data.metadata = {
                  ...(intlLine.price_data.product_data.metadata || {}),
                  itemType: "fee",
                  itemId: "intl-fee",
                };
                line_items.push(intlLine);
              } else if (intlLine) {
                line_items.push(intlLine);
              }
            }

            const session = await stripe.checkout.sessions.create({
              mode: "payment",
              line_items,
              customer_email: purchaser.email || undefined,
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: {
                order_channel: orderChannel,
                order_mode: orderChannel,
                purchaser_name: purchaser.name || "",
                purchaser_email: purchaser.email || "",
                purchaser_phone: purchaser.phone || "",
                purchaser_title: purchaser.title || "",
                purchaser_addr1: purchaser.address1 || "",
                purchaser_addr2: purchaser.address2 || "",
                purchaser_city: purchaser.city || "",
                purchaser_state: purchaser.state || "",
                purchaser_postal: purchaser.postal || "",
                // ✅ store normalized code to keep reporting consistent
                purchaser_country: purchaserCountry || "",
                cart_count: String(lines.length || 0),
              },
            });
            return REQ_OK(res, {
              requestId,
              url: session.url,
              id: session.id,
              mode: orderChannel,
            });
          }

          const items = Array.isArray(body.items) ? body.items : [];
          if (!items.length) return REQ_ERR(res, 400, "no-items", { requestId });

          const session = await stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            line_items: items.map((it) => ({
              quantity: Math.max(1, Number(it.quantity || 1)),
              price_data: {
                currency: "usd",
                unit_amount: dollarsToCents(it.price || 0),
                product_data: { name: String(it.name || "Item") },
              },
            })),
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: { order_channel: orderChannel, order_mode: orderChannel },
          });

          return REQ_OK(res, {
            requestId,
            url: session.url,
            id: session.id,
            mode: orderChannel,
          });
        } catch (e) {
          return errResponse(res, 500, "checkout-create-failed", req, e, {
            hint:
              "If this only fails in live-test/live, it usually means STRIPE_SECRET_KEY_LIVE or webhook secret is missing/mismatched in that environment.",
          });
        }
      }

      if (action === "stripe_webhook") {
        try {
          const sig = req.headers["stripe-signature"];
          if (!sig) return REQ_ERR(res, 400, "missing-signature", { requestId });

          const whsecLive = (process.env.STRIPE_WEBHOOK_SECRET_LIVE || "").trim();
          const whsecTest = (process.env.STRIPE_WEBHOOK_SECRET_TEST || "").trim();
          const whsecFallback = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

          const trySecrets = [whsecLive, whsecTest, whsecFallback].filter(Boolean);
          if (!trySecrets.length) {
            console.error("[webhook] no webhook secrets configured");
            return REQ_ERR(res, 500, "missing-webhook-secret", { requestId });
          }

          const raw = await readRawBody(req);

          const stripeAny =
            (await getStripe("live")) ||
            (await getStripe("test")) ||
            (await getStripe());
          if (!stripeAny)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          let event = null;
          let verifiedWith = "";

          for (const secret of trySecrets) {
            try {
              event = stripeAny.webhooks.constructEvent(raw, sig, secret);
              verifiedWith =
                secret === whsecLive
                  ? "live"
                  : secret === whsecTest
                  ? "test"
                  : "fallback";
              break;
            } catch {}
          }

          if (!event) {
            console.error(
              "Webhook signature verification failed with all known secrets"
            );
            return REQ_ERR(res, 400, "invalid-signature", { requestId });
          }

          console.log(
            "[webhook] verifiedWith=",
            verifiedWith,
            "type=",
            event.type,
            "livemode=",
            !!event.livemode
          );

          switch (event.type) {
            case "checkout.session.completed": {
              const session = event.data.object;
              const mode = await resolveModeFromSession(session);

              console.log("[webhook] checkout.session.completed", {
                requestId,
                sessionId: session?.id || null,
                mode,
                verifiedWith,
                livemode: !!event.livemode,
              });

              const order = await saveOrderFromSession(session.id || session, {
                mode,
              });

              // ✅ write-once createdAt + hash (tamper detection)
              await ensureOrderIntegrityMarkers(order, requestId);

              // ✅ Centralized: immediate receipts + chair + admin copy (idempotent)
              await sendPostOrderEmails(order, requestId);

              break;
            }

            case "charge.refunded": {
              const refund = event.data.object;
              await applyRefundToOrder(refund.charge, refund);
              break;
            }

            default:
              break;
          }

          return REQ_OK(res, { requestId, received: true, verifiedWith });
        } catch (e) {
          return errResponse(res, 500, "webhook-failed", req, e);
        }
      }

      if (action === "register_item") {
        const {
          id = "",
          name = "",
          chairEmails = [],
          publishStart = "",
          publishEnd = "",
          reportFrequency,
          kind,
        } = body || {};

        if (!id || !name)
          return REQ_ERR(res, 400, "id-and-name-required", { requestId });

        const emails = Array.isArray(chairEmails)
          ? chairEmails
          : String(chairEmails || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);

        const existing = await kvHgetallSafe(`itemcfg:${id}`);

        const freq = computeMergedFreq(
          reportFrequency,
          existing,
          "monthly" // register_item remains generic
        );

        const cfg = {
          ...existing,
          id,
          name,
          kind: kind || existing?.kind || "",
          chairEmails: emails,
          publishStart,
          publishEnd,
          reportFrequency: freq,
          updatedAt: new Date().toISOString(),
        };

        const ok1 = await kvHsetSafe(`itemcfg:${id}`, cfg);
        const ok2 = await kvSaddSafe("itemcfg:index", id);
        if (!ok1 || !ok2)
          return REQ_OK(res, { requestId, ok: true, warning: "kv-unavailable" });

        return REQ_OK(res, { requestId, ok: true, cfg });
      }

      // -------- ADMIN (auth required below) --------
      if (!(await requireAdminAuth(req, res))) return;

      // ✅ Lockdown enforcement (blocks admin write actions when enabled)
      if (!(await enforceLockdownIfNeeded(req, res, action, requestId))) return;

      // ✅ NEW: toggle lockdown (admin-only)
      if (action === "set_lockdown") {
        const on = coerceBool(body?.on ?? body?.enabled ?? body?.lockdown ?? false);
        const message = String(body?.message || body?.note || "").trim();
        const payload = {
          on,
          message,
          updatedAt: new Date().toISOString(),
          updatedByIp: String(getClientIp(req) || ""),
        };
        await kvSetSafe(LOCKDOWN_KEY, payload);
        return REQ_OK(res, { requestId, ok: true, lockdown: payload });
      }

      // ✅ NEW: Patch older orders with missing Court/Court# (admin-only)
      // Used by /admin/debug3.html to repair legacy data so chair reports are correct.
      if (action === "admin_patch_order_court") {
        const orderId = String(body?.orderId || body?.id || "").trim();
        const courtName = String(body?.courtName || body?.court || "").trim();
        const courtNo = String(body?.courtNo || body?.court_number || body?.courtNumber || "").trim();
        const overwrite = coerceBool(body?.overwrite ?? false);

        if (!orderId) {
          return REQ_ERR(res, 400, "missing-orderId", { requestId });
        }
        if (!courtName && !courtNo) {
          return REQ_ERR(res, 400, "missing-court", {
            requestId,
            message: "Provide courtName and/or courtNo.",
          });
        }

        const key = `order:${orderId}`;
        const existing = await kvGetSafe(key, null);
        if (!existing) {
          return REQ_ERR(res, 404, "order-not-found", { requestId, orderId });
        }

        const patched = patchOrderCourtFields(existing, { courtName, courtNo, overwrite });
        if (!patched) {
          return REQ_ERR(res, 500, "patch-failed", { requestId, orderId });
        }

        const finalOrder = rehashOrderAfterAdminPatch(patched, {
          patchedBy: String(getClientIp(req) || ""),
          patchNote: "court_name_number",
        });

        await kvSetSafe(key, finalOrder);

        // Also keep a small patch audit trail (last 100)
        try {
          const logKey = "admin:order_patches";
          const entry = {
            ts: Date.now(),
            at: new Date().toISOString(),
            requestId,
            action,
            orderId,
            courtName,
            courtNo,
            overwrite,
            ip: String(getClientIp(req) || ""),
          };
          await kv.lpush(logKey, entry);
          await kv.ltrim(logKey, 0, 99);
        } catch {}

        // Clear warm-cache so next report run doesn't reuse stale in-memory orders
        try {
          clearOrdersCache();
        } catch {}

        return REQ_OK(res, {
          requestId,
          ok: true,
          orderId,
          patched: {
            courtName,
            courtNo,
            overwrite,
          },
        });
      }

      if (action === "save_feature_flags") {
        const incoming =
          body &&
          typeof body === "object" &&
          body.flags &&
          typeof body.flags === "object"
            ? body.flags
            : body && typeof body === "object"
            ? body
            : {};

        const nextFlags = { ...DEFAULT_FEATURE_FLAGS };
        for (const k of Object.keys(DEFAULT_FEATURE_FLAGS)) {
          if (k in incoming) nextFlags[k] = coerceBool(incoming[k]);
        }

        const payload = {
          flags: nextFlags,
          updatedAt: new Date().toISOString(),
        };

        await kvSetSafe(FEATURE_FLAGS_KEY, payload);
        return REQ_OK(res, { requestId, ok: true, ...payload });
      }

      if (action === "debug_schedule") {
        const id = String(body?.id || url.searchParams.get("id") || "").trim();
        if (!id) {
          return REQ_ERR(res, 400, "missing-id", {
            requestId,
            message: "Missing id (body.id or ?id=)",
          });
        }
        try {
          const result = await debugScheduleForItem(id);
          return REQ_OK(res, { requestId, ...result });
        } catch (e) {
          return errResponse(res, 500, "debug-failed", req, e);
        }
      }

      if (action === "purge_orders") {
        const confirm = String(body?.confirm || "");
        if (confirm !== "PURGE ORDERS") {
          return REQ_ERR(res, 400, "confirmation-required", {
            requestId,
            expected: "PURGE ORDERS",
            received: confirm,
            note: "This safeguard prevents accidental data loss.",
          });
        }

        let mode = String(body?.mode || "").toLowerCase() || "test";
        const hardFlag = Boolean(body?.hard);

        if (!["test", "live_test", "live"].includes(mode)) {
          return REQ_ERR(res, 400, "invalid-mode", {
            requestId,
            mode,
            expected: ["test", "live_test", "live"],
          });
        }

        try {
          const result = await purgeOrdersByMode(mode, { hard: hardFlag });
          return REQ_OK(res, {
            requestId,
            ok: true,
            message:
              mode === "live"
                ? "Live orders purge requested. Core safety rules determine whether only soft-delete is allowed."
                : `Orders for mode="${mode}" purged successfully.`,
            ...result,
          });
        } catch (err) {
          return errResponse(res, 500, "purge-failed", req, err);
        }
      }

      if (action === "get_settings") {
        const { env, overrides, effective } = await getEffectiveSettings();
        return REQ_OK(res, { requestId, ok: true, env, overrides, effective });
      }

      if (action === "send_full_report") {
        try {
          const mod = await import("./admin/send-full.js");
          const result = await mod.default();
          return REQ_OK(res, { requestId, ...(result || { ok: true }) });
        } catch (e) {
          return errResponse(res, 500, "send-full-failed", req, e);
        }
      }

      if (action === "send_month_to_date") {
        try {
          const mod = await import("./admin/send-month-to-date.js");
          const result = await mod.default();
          return REQ_OK(res, { requestId, ...(result || { ok: true }) });
        } catch (e) {
          return errResponse(res, 500, "send-mtd-failed", req, e);
        }
      }

      if (action === "set_receipts_zip_prefs") {
        if (!(await requireAdminAuth(req, res))) return;
        const body = await readJsonBody(req);
        const monthly = !!body?.monthly;
        const weekly = !!body?.weekly;
        const channel = body?.channel ? String(body.channel) : undefined;

        const next = await setReportingPrefs({
          receiptZip: { monthly, weekly },
          ...(channel ? { channel } : {}),
        });

        return REQ_OK(res, { requestId, ok: true, prefs: next });
      }

      if (action === "set_reporting_channel") {
        if (!(await requireAdminAuth(req, res))) return;
        const body = await readJsonBody(req);
        const channel = String(body?.channel || "").trim();
        const next = await setReportingPrefs({ channel });
        return REQ_OK(res, { requestId, ok: true, prefs: next });
      }

      if (action === "send_monthly_chair_reports") {
        await loadAllOrdersWithRetry();

        let schedulerMod;
        try {
          schedulerMod = await import("./admin/report-scheduler.js");
        } catch (e) {
          return errResponse(res, 500, "scheduler-missing", req, e);
        }

        const { runScheduledChairReports } = schedulerMod || {};
        if (typeof runScheduledChairReports !== "function") {
          return REQ_ERR(res, 500, "scheduler-invalid", { requestId });
        }

        const baseNow = new Date();


        const { prefs: reportingPrefs, mode: reportMode } = await getEffectiveReportMode();
        const wrappedSendItemReport = async (opts) => {
          const kind = String(opts?.kind || "").toLowerCase();

          // 5-minute phase gaps by category (banquet → add-on → catalog → other)
          // We schedule via Resend `scheduled_at` (when enabled) so the cron run
          // can finish quickly, while emails are spaced out.
          const OFFSETS_MIN = {
            banquet: 0,
            addon: 5,
            "add-on": 5,
            catalog: 10,
            supplies: 15,
            other: 20,
          };

          // Unknown kinds fall into "other"
          const offsetMinutes =
            typeof OFFSETS_MIN[kind] === "number" ? OFFSETS_MIN[kind] : OFFSETS_MIN.other;

          let scheduledAt;
          if (offsetMinutes > 0) {
            const ts = baseNow.getTime() + offsetMinutes * 60 * 1000;
            scheduledAt = new Date(ts).toISOString();
          }

          return sendItemReportEmailInternal({ ...opts, scheduledAt, mode: reportMode });
        };

        const { sent, skipped, errors, itemsLog } = await runScheduledChairReports({
          now: baseNow,
          sendItemReportEmailInternal: wrappedSendItemReport,
        });

        // ✅ Also send last-month receipts ZIP
        // (Can be disabled for testing via DISABLE_RECEIPTS_ZIP_AUTO=1)
        let receiptsZip = { monthly: { ok: false, skipped: true }, weekly: { ok: false, skipped: true } };
        const disableReceiptsZip = String(process.env.DISABLE_RECEIPTS_ZIP_AUTO || "0") === "1";
        if (!disableReceiptsZip) {
          try {
            const { receiptZip } = reportingPrefs || {};
            // weekly
            if (shouldSendReceiptZip({ prefs: reportingPrefs, kind: "weekly" })) {
              receiptsZip.weekly = await emailWeeklyReceiptsZip({ mode: reportMode });
            }
            // monthly
            if (shouldSendReceiptZip({ prefs: reportingPrefs, kind: "monthly" })) {
              receiptsZip.monthly = await emailMonthlyReceiptsZip({ mode: reportMode });
            }
          } catch (e) {
            console.error("receipts_zip_auto_failed", e?.message || e);
          }
        }

        return REQ_OK(res, {
          requestId,
          ok: true,
          sent,
          skipped,
          errors,
          scope: "current-month",
          receiptsZip,
        });
      }

      
      if (action === "send_test_chair_reports") {
        if (!(await requireAdminAuth(req, res))) return;

        const body = await readJsonBody(req);
        const to = String(body?.to || "kfors@verizon.net").trim();
        const frequency = String(body?.frequency || "monthly").trim().toLowerCase();
        const scope = String(body?.scope || "current-month").trim();
        const previewOnly = !!body?.previewOnly;


        const { mode: reportMode } = await getEffectiveReportMode();
        if (!to) return REQ_ERR(res, 400, "missing-test-email", { requestId });

        const freqNorm = frequency === "all" ? "all" : normalizeReportFrequency(frequency);

        const orders = await loadAllOrdersWithRetry();
        const ids = await kvSmembersSafe("itemcfg:index");

        let sent = 0,
          skipped = 0,
          errors = 0;

        const results = [];

        for (const itemId of ids) {
          const cfg = await kvHgetallSafe(`itemcfg:${itemId}`);
          const itemFreq = normalizeReportFrequency(cfg?.reportFrequency || cfg?.frequency || "monthly");

          if (freqNorm !== "all" && itemFreq !== freqNorm) {
            skipped++;
            continue;
          }

          try {
            const r = await sendItemReportEmailInternal({
              kind: cfg?.kind || cfg?.type || "item",
              id: itemId,
              label: cfg?.label || cfg?.name || itemId,
              scope,
              toOverride: [to],
              subjectPrefix: `[TEST ${freqNorm}] `,
              previewOnly,
            });

            if (r?.ok) sent++;
            else errors++;

            results.push({ itemId, ok: !!r?.ok, preview: !!r?.preview, rowCount: r?.rowCount || 0, error: r?.error || null });
          } catch (e) {
            errors++;
            results.push({ itemId, ok: false, error: e?.message || String(e) });
          }
        }

        return REQ_OK(res, {
          requestId,
          ok: true,
          to,
          frequency: freqNorm,
          scope,
          previewOnly,
          sent,
          skipped,
          errors,
          results,
        });
      }

if (action === "send_end_of_event_reports") {
        const now = Date.now();
        const ids = await kvSmembersSafe("itemcfg:index");
        let sent = 0,
          skipped = 0,
          errors = 0;

        for (const itemId of ids) {
          const cfg = await kvHgetallSafe(`itemcfg:${itemId}`);
          const publishEnd = cfg?.publishEnd ? Date.parse(cfg.publishEnd) : NaN;
          if (isNaN(publishEnd) || publishEnd > now) {
            skipped += 1;
            continue;
          }

          const already = await kvGetSafe(`itemcfg:${itemId}:end_sent`, false);
          if (already) {
            skipped += 1;
            continue;
          }

          const kind =
            String(cfg?.kind || "").toLowerCase() ||
            (itemId.includes("addon") ? "addon" : "banquet");
          const label = cfg?.name || itemId;

          const result = await sendItemReportEmailInternal({
            kind,
            id: itemId,
            label,
            scope: "full",
          });
          if (result.ok) {
            await kvSetSafe(`itemcfg:${itemId}:end_sent`, new Date().toISOString());
            sent += 1;
          } else {
            errors += 1;
          }
        }

        return REQ_OK(res, {
          requestId,
          ok: true,
          sent,
          skipped,
          errors,
          scope: "full",
        });
      }

      if (action === "clear_orders") {
        await kvDelSafe("orders:index");
        return REQ_OK(res, { requestId, ok: true, message: "orders index cleared" });
      }

      if (action === "create_refund") {
        try {
          let mode = String(body?.mode || "").toLowerCase().trim();
          if (!["test", "live_test", "live"].includes(mode)) {
            mode = await getEffectiveOrderChannel().catch(() => "test");
          }

          const stripe = await getStripe(mode);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId, mode });

          const payment_intent = String(body.payment_intent || "").trim();
          const charge = String(body.charge || "").trim();
          const amount_cents_raw = body.amount_cents;
          const args = {};
          if (amount_cents_raw != null) args.amount = cents(amount_cents_raw);
          if (payment_intent) args.payment_intent = payment_intent;
          else if (charge) args.charge = charge;
          else
            return REQ_ERR(res, 400, "missing-payment_intent-or-charge", {
              requestId,
            });

          const rf = await stripe.refunds.create(args);
          try {
            await applyRefundToOrder(rf.charge, rf);
          } catch {}
          return REQ_OK(res, {
            requestId,
            ok: true,
            id: rf.id,
            status: rf.status,
            mode,
          });
        } catch (e) {
          return errResponse(res, 500, "refund-failed", req, e);
        }
      }

      
      // =========================================================================
      // Manual refund marks (for refunds performed directly in Stripe)
      // Persist a "row is refunded/removed" mark in KV so reporting_main can hide it
      // and add a REMOVED/REFUNDED line in exports.
      //
      // KV keys:
      // - manual_refunds:index                 (SET of orderIds)
      // - manual_refunds:byOrder:<orderId>     (JSON array of refund mark records)
      // =========================================================================

      if (action === "mark_manual_refund") {
        const ok = await requireAdminAuth(req, res);
        if (!ok) return;

        // honor lockdown for any write action (this action is included in isWriteAction)
        // (enforceLockdownIfNeeded is called earlier for write actions; this is extra safety)
        await enforceLockdownIfNeeded(req, res, action, requestId);
        if (res.writableEnded) return;

        const orderId = String(body?.orderId || body?.order_id || "").trim();
        const rowId = String(body?.rowId || body?.row_id || body?.rowKey || "").trim();

        if (!orderId) return REQ_ERR(res, 400, "missing-orderId", { requestId });
        if (!rowId) return REQ_ERR(res, 400, "missing-rowId", { requestId });

        const rec = {
          orderId,
          rowId,
          itemId: String(body?.itemId || body?.item_id || "").trim() || null,
          itemName: String(body?.itemName || body?.item_name || body?.item || "").trim() || null,
          qty: Number.isFinite(Number(body?.qty)) ? Number(body.qty) : null,
          createdAt: String(body?.createdAt || body?.created_at || "").trim() || null,
          note: String(body?.note || "").trim() || null,
          markedAt: new Date().toISOString(),
        };

        const byOrderKey = `manual_refunds:byOrder:${orderId}`;

        const existing = (await kvGetSafe(byOrderKey, [])) || [];
        const list = Array.isArray(existing) ? existing : [];

        // Upsert by rowId (so you can re-mark the same row without duplicates)
        const without = list.filter((x) => String(x?.rowId || "") !== rowId);
        without.push(rec);

        await kvSetSafe(byOrderKey, without);
        await kvSaddSafe("manual_refunds:index", orderId);

        return REQ_OK(res, { requestId, ok: true, saved: true, orderId, rowId });
      }

      if (action === "unmark_manual_refund") {
        const ok = await requireAdminAuth(req, res);
        if (!ok) return;

        await enforceLockdownIfNeeded(req, res, action, requestId);
        if (res.writableEnded) return;

        const orderId = String(body?.orderId || body?.order_id || "").trim();
        const rowId = String(body?.rowId || body?.row_id || body?.rowKey || "").trim();

        if (!orderId) return REQ_ERR(res, 400, "missing-orderId", { requestId });
        if (!rowId) return REQ_ERR(res, 400, "missing-rowId", { requestId });

        const byOrderKey = `manual_refunds:byOrder:${orderId}`;
        const existing = (await kvGetSafe(byOrderKey, [])) || [];
        const list = Array.isArray(existing) ? existing : [];
        const next = list.filter((x) => String(x?.rowId || "") !== rowId);
        await kvSetSafe(byOrderKey, next);

        return REQ_OK(res, { requestId, ok: true, removed: true, orderId, rowId });
      }

      // Read back manual refund marks (admin only). Optional filter by orderIds.
      if (action === "get_manual_refunds") {
        const ok = await requireAdminAuth(req, res);
        if (!ok) return;

        const orderIdsIn = Array.isArray(body?.orderIds) ? body.orderIds : null;
        let orderIds = orderIdsIn
          ? orderIdsIn.map((x) => String(x || "").trim()).filter(Boolean)
          : await kvSmembersSafe("manual_refunds:index");

        // de-dupe
        orderIds = Array.from(new Set(orderIds));

        const out = [];
        for (const oid of orderIds) {
          const byOrderKey = `manual_refunds:byOrder:${oid}`;
          const list = (await kvGetSafe(byOrderKey, [])) || [];
          if (Array.isArray(list)) {
            for (const rec of list) out.push(rec);
          }
        }

        return REQ_OK(res, { requestId, ok: true, count: out.length, records: out });
      }

// =========================================================================
      // ✅ FIXED: save_* actions no longer overwrite reportFrequency to "monthly"
      // =========================================================================

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets) ? body.banquets : [];
        await kvSetSafe("banquets", list);

        try {
          for (const b of list) {
            const id = String(b?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(b?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              b?.chairEmails,
              b?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              b?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              b?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              b?.reportFrequency ?? b?.report_frequency,
              existing,
              "daily"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: "banquet",
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      if (action === "save_addons") {
        const list = Array.isArray(body.addons) ? body.addons : [];
        await kvSetSafe("addons", list);

        try {
          for (const a of list) {
            const id = String(a?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(a?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              a?.chairEmails,
              a?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              a?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              a?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              a?.reportFrequency ?? a?.report_frequency,
              existing,
              "monthly"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: "addon",
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      if (action === "save_products") {
        const list = Array.isArray(body.products) ? body.products : [];
        await kvSetSafe("products", list);

        try {
          for (const p of list) {
            const id = String(p?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(p?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              p?.chairEmails,
              p?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              p?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              p?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              p?.reportFrequency ?? p?.report_frequency,
              existing,
              "monthly"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: "catalog",
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      if (action === "save_catalog_items") {
        const cat = normalizeCat(url.searchParams.get("cat") || body?.cat || "catalog");
        const key = catalogItemsKeyForCat(cat);

        const list = Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.products)
          ? body.products
          : [];
        await kvSetSafe(key, list);

        try {
          for (const p of list) {
            const id = String(p?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(p?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              p?.chairEmails,
              p?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              p?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              p?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              p?.reportFrequency ?? p?.report_frequency,
              existing,
              "monthly"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: cat === "catalog" ? "catalog" : `catalog:${cat}`,
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, cat, key, count: list.length });
      }

      if (action === "save_settings") {
        const allow = {};
        [
          "RESEND_FROM",
          "REPORTS_CC",
          "REPORTS_BCC",
          "EMAIL_RECEIPTS",
          "SITE_BASE_URL",
          "MAINTENANCE_ON",
          "MAINTENANCE_MESSAGE",
          "REPORTS_SEND_SEPARATE",
          "REPLY_TO",
          "EVENT_START",
          "EVENT_END",
          "REPORT_ORDER_DAYS",
          "REPORT_FREQUENCY",
          "REPORT_WEEKDAY",
        ].forEach((k) => {
          if (k in body) allow[k] = body[k];
        });

        if ("MAINTENANCE_ON" in allow)
          allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);

        if ("REPORT_FREQUENCY" in allow) {
          allow.REPORT_FREQUENCY = normalizeReportFrequency(allow.REPORT_FREQUENCY);
        }

        if ("REPORT_WEEKDAY" in allow) {
          let wd = parseInt(allow.REPORT_WEEKDAY, 10);
          if (!Number.isFinite(wd) || wd < 1 || wd > 7) wd = 1;
          allow.REPORT_WEEKDAY = String(wd);
        }

        if (Object.keys(allow).length) {
          await kvHsetSafe("settings:overrides", allow);
        }
        return REQ_OK(res, { requestId, ok: true, overrides: allow });
      }

      if (action === "save_checkout_mode") {
        const { stripeMode, liveAuto, liveStart, liveEnd } = body || {};

        let mode = String(stripeMode || "test").toLowerCase();
        if (!["test", "live_test", "live"].includes(mode)) mode = "test";

        const normalizeIso = (v) => {
          if (!v || typeof v !== "string") return "";
          const t = Date.parse(v.trim());
          if (!Number.isFinite(t)) return "";
          return new Date(t).toISOString();
        };

        const patch = {
          stripeMode: mode,
          liveAuto: !!liveAuto,
          liveStart: normalizeIso(liveStart),
          liveEnd: normalizeIso(liveEnd),
        };

        const cfg = await saveCheckoutSettings(patch);
        const effectiveChannel = await getEffectiveOrderChannel();

        return REQ_OK(res, { requestId, ok: true, cfg, effectiveChannel });
      }

      return REQ_ERR(res, 400, "unknown-action", { requestId });
    }

    return REQ_ERR(res, 405, "method-not-allowed", { requestId });
  } catch (e) {
    return errResponse(res, 500, "router-failed", req, e);
  }
}

// Vercel Node 22 runtime
export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};

