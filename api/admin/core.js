// /api/admin/core.js
import crypto from "crypto";
import { kv } from "@vercel/kv";
import { Resend } from "resend";
import ExcelJS from "exceljs";
import JSZip from "jszip";

// ============================================================================
// REPORT EMAIL STAGGERING (scheduled_at)
// ============================================================================
// We keep this intentionally tiny and low-risk.
// When enabled (REPORTS_ALLOW_SCHEDULED_AT=1) AND a Yahoo recipient is present,
// we schedule chair report emails 1 minute apart *within a single invocation*.
//
// Why module state?
// - Vercel runs the report sender in one function invocation; the reports are
//   generated/sent sequentially.
// - We only need a simple counter to offset scheduled_at times without adding
//   sleeps or new KV writes.
// - If a new invocation happens (or the process is recycled), this naturally
//   resets.
let _REPORT_STAGGER = {
  baseMs: 0,
  idx: 0,
  lastTouchedMs: 0,
};

function nextReportScheduledAtIso({ allow, hasYahoo, explicitIso }) {
  if (!allow || !hasYahoo) return "";
  if (explicitIso) return explicitIso; // caller already set it

  const now = Date.now();
  // Reset the counter if we haven't used it recently (new cron/manual run).
  if (!_REPORT_STAGGER.baseMs || now - (_REPORT_STAGGER.lastTouchedMs || 0) > 5 * 60_000) {
    _REPORT_STAGGER.baseMs = now;
    _REPORT_STAGGER.idx = 0;
  }
  _REPORT_STAGGER.lastTouchedMs = now;

  // First email goes immediately; subsequent emails are scheduled 1 minute apart.
  const idx = _REPORT_STAGGER.idx++;
  if (idx <= 0) return "";

  // Schedule safely in the future. Resend requires scheduled_at > ~now+30s.
  const t = _REPORT_STAGGER.baseMs + idx * 60_000;
  if (t <= now + 30_000) return "";
  return new Date(t).toISOString();
}

// ============================================================================
// STRIPE MODE-AWARE KEY SELECTION
// ============================================================================

// Cache Stripe clients by secret key (so switching modes doesn't create duplicates)
let _stripeBySecret = Object.create(null);

/**
 * Returns the Stripe SECRET client for the *current effective mode*.
 * Modes:
 *   test      → STRIPE_SECRET_KEY_TEST
 *   live_test → STRIPE_SECRET_KEY_LIVE
 *   live      → STRIPE_SECRET_KEY_LIVE
 *
 * Auto-reverts to test whenever the LIVE window is expired (via
 * getEffectiveOrderChannel()).
 */
async function getStripe() {
  let mode = "test";
  try {
    mode = await getEffectiveOrderChannel(); // defined further below
  } catch (e) {
    console.error(
      "getStripe: failed to resolve effective order channel, falling back to test.",
      e
    );
    mode = "test";
  }

  const env = process.env || {};
  const TEST_SECRET = (env.STRIPE_SECRET_KEY_TEST || "").trim();
  const LIVE_SECRET = (env.STRIPE_SECRET_KEY_LIVE || "").trim();

  let key = "";
  if (mode === "test") key = TEST_SECRET;
  else key = LIVE_SECRET; // live_test + live both use LIVE key

  if (!key) {
    console.error("getStripe: No valid Stripe secret key configured for mode:", mode);
    return null;
  }

  if (_stripeBySecret[key]) return _stripeBySecret[key];

  const { default: Stripe } = await import("stripe");
  const client = new Stripe(key);
  _stripeBySecret[key] = client;
  return client;
}

/**
 * Returns the correct STRIPE PUBLISHABLE KEY for front-end usage.
 * This should be called by router.js when building checkout sessions.
 *
 * @param {string} mode - effectiveChannel (test | live_test | live)
 */
function getStripePublishableKey(mode = "test") {
  const env = process.env || {};
  const TEST_PK = (env.STRIPE_PUBLISHABLE_KEY_TEST || "").trim();
  const LIVE_PK = (env.STRIPE_PUBLISHABLE_KEY_LIVE || "").trim();
  if (mode === "test") return TEST_PK;
  return LIVE_PK; // live_test + live
}

// ---- Checkout mode & window settings ----
const CHECKOUT_SETTINGS_KEY = "settings:checkout";

/**
 * Raw checkout settings from KV.
 * {
 *   stripeMode: "test" | "live_test" | "live",
 *   liveAuto: boolean (legacy – now treated as always-on),
 *   liveStart: string,
 *   liveEnd:   string
 * }
 */
async function getCheckoutSettingsRaw() {
  const s = await kv.get(CHECKOUT_SETTINGS_KEY);
  if (!s || typeof s !== "object") {
    return {
      stripeMode: "test",
      liveAuto: true,
      liveStart: "",
      liveEnd: "",
    };
  }
  const out = { ...s };
  if (!out.stripeMode) out.stripeMode = "test";
  if (out.liveAuto === undefined || out.liveAuto === null) out.liveAuto = true;
  return out;
}

async function saveCheckoutSettings(patch = {}) {
  const current = await getCheckoutSettingsRaw();
  const next = { ...current, ...patch };
  await kv.set(CHECKOUT_SETTINGS_KEY, next);
  return next;
}

/**
 * Same as raw, but with automatic LIVE window handling:
 * - If stripeMode is "live" and window exists and now outside -> revert to test + persist.
 */
async function getCheckoutSettingsAuto(now = new Date()) {
  let s = await getCheckoutSettingsRaw();
  let changed = false;

  if (s.stripeMode === "live") {
    const start = s.liveStart ? new Date(s.liveStart) : null;
    const end = s.liveEnd ? new Date(s.liveEnd) : null;
    const hasWindow = !!(start || end);

    const tooEarly = start && now < start;
    const tooLate = end && now > end;

    if (hasWindow && (tooEarly || tooLate)) {
      s = { ...s, stripeMode: "test" };
      changed = true;
    }
  }

  if (changed) await kv.set(CHECKOUT_SETTINGS_KEY, s);
  return s;
}

/**
 * Compute effective channel stamped onto each order:
 * Returns: "test" | "live_test" | "live"
 */
async function getEffectiveOrderChannel(now = new Date()) {
  const s = await getCheckoutSettingsAuto(now);

  let mode = s.stripeMode;
  if (mode !== "live" && mode !== "live_test" && mode !== "test") mode = "test";

  if (mode === "live") {
    const start = s.liveStart ? new Date(s.liveStart) : null;
    const end = s.liveEnd ? new Date(s.liveEnd) : null;
    const hasWindow = !!(start || end);

    const tooEarly = start && now < start;
    const tooLate = end && now > end;

    if (hasWindow && (tooEarly || tooLate)) mode = "test";
  }

  return mode;
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ---- Mail “From / Reply-To” ----
const RESEND_FROM = (process.env.RESEND_FROM || "").trim();
const REPLY_TO = (process.env.REPLY_TO || process.env.REPORTS_REPLY_TO || "").trim();
const REPORTS_LOG_TO = (process.env.REPORTS_LOG_TO || "").trim();
const CONTACT_TO = (process.env.CONTACT_TO || "pa_sessions@yahoo.com").trim();

// Backup receipts inbox (XLSX copy of each receipt)
const EMAIL_RECEIPTS = (process.env.EMAIL_RECEIPTS || "").trim();

const REQ_OK = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });

// ---------- helpers ----------
function cents(n) {
  return Math.round(Number(n || 0));
}
function dollarsToCents(n) {
  return Math.round(Number(n || 0) * 100);
}
function toCentsAuto(v) {
  const n = Number(v || 0);
  return n < 1000 ? Math.round(n * 100) : Math.round(n);
}

async function kvGetSafe(key, fallback = null) {
  try {
    const v = await kv.get(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
async function kvHsetSafe(key, obj) {
  try {
    await kv.hset(key, obj);
    return true;
  } catch {
    return false;
  }
}
async function kvSaddSafe(key, val) {
  try {
    await kv.sadd(key, val);
    return true;
  } catch {
    return false;
  }
}
async function kvSetSafe(key, val) {
  try {
    await kv.set(key, val);
    return true;
  } catch {
    return false;
  }
}
async function kvHgetallSafe(key) {
  try {
    return (await kv.hgetall(key)) || {};
  } catch {
    return {};
  }
}
async function kvSmembersSafe(key) {
  try {
    return (await kv.smembers(key)) || [];
  } catch {
    return [];
  }
}
async function kvDelSafe(key) {
  try {
    await kv.del(key);
    return true;
  } catch {
    return false;
  }
}

// Small sleep helper for retries
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Email retry helper (3 attempts, spacing 2s → 5s → 10s) ----
async function sendWithRetry(sendFn, label = "email") {
  const attempts = [0, 2000, 5000, 10000];
  let lastErr = null;

  for (let i = 1; i <= 3; i++) {
    try {
      if (attempts[i] > 0) await sleep(attempts[i]);
      const result = await sendFn();
      return { ok: true, attempt: i, result };
    } catch (err) {
      lastErr = err;
      console.error(`Retry ${i} failed for ${label}:`, err);
    }
  }
  return { ok: false, error: lastErr };
}

// ---------------------------------------------------------------------------
// ORDER HASHING (immutable receipt / tamper detection)
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

function computeOrderHash(order) {
  const o = order && typeof order === "object" ? order : {};
  const clone = { ...o };
  delete clone.hash;
  delete clone.hashVersion;
  delete clone.hashCreatedAt;
  const normalized = stableStringify(clone);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function attachImmutableOrderHash(order) {
  const hashCreatedAt = new Date().toISOString();
  const next = { ...order, hashVersion: 1, hashCreatedAt };
  next.hash = computeOrderHash(next);
  return next;
}

function verifyOrderHash(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "not-object" };
  if (!order.hash || !order.hashVersion) return { ok: false, reason: "missing-hash" };
  const expected = computeOrderHash(order);
  return { ok: expected === order.hash, expected, actual: order.hash };
}

// ---------------------------------------------------------------------------
// ADMIN PATCH HELPERS (legacy data fixes)
// - Some early/older orders may be missing court name/# on attendee metadata.
// - We patch lines[].meta fields in a consistent way so reports/export work.
// - After patching, we re-hash the order so "Verify hash" reflects the new
//   admin-approved stored state (and we record patch metadata on the order).
// ---------------------------------------------------------------------------

function setIfBlankOrOverwrite(target, key, val, overwrite) {
  if (!target || typeof target !== "object") return;
  const v = String(val ?? "").trim();
  if (!v) return;
  const cur = String(target[key] ?? "").trim();
  if (overwrite || !cur) target[key] = v;
}

// Exported so router.js can reuse the same normalization.
export function patchOrderCourtFields(order, { courtName = "", courtNo = "", overwrite = false } = {}) {
  const o = order && typeof order === "object" ? { ...order } : null;
  if (!o) return null;

  // Purchaser (optional; some UIs may want this later)
  if (o.purchaser && typeof o.purchaser === "object") {
    setIfBlankOrOverwrite(o.purchaser, "courtName", courtName, overwrite);
    setIfBlankOrOverwrite(o.purchaser, "courtNo", courtNo, overwrite);
    setIfBlankOrOverwrite(o.purchaser, "court", courtName, overwrite);
    setIfBlankOrOverwrite(o.purchaser, "court_number", courtNo, overwrite);
  }

  // Lines / attendee meta
  const lines = Array.isArray(o.lines) ? o.lines.map((ln) => ({ ...ln })) : [];
  for (const ln of lines) {
    ln.meta = ln.meta && typeof ln.meta === "object" ? { ...ln.meta } : {};

    // Court name (write several aliases for compatibility)
    setIfBlankOrOverwrite(ln.meta, "attendeeCourt", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtName", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_name", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "courtName", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court_name", courtName, overwrite);

    // Court number
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtNumber", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtNo", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtNum", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_number", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_no", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_num", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "courtNumber", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "courtNo", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court_no", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court_number", courtNo, overwrite);
  }
  o.lines = lines;
  return o;
}

export function rehashOrderAfterAdminPatch(order, { patchedBy = "", patchNote = "" } = {}) {
  if (!order || typeof order !== "object") return order;
  const next = { ...order };
  next.admin_patched = true;
  next.admin_patched_at = new Date().toISOString();
  if (patchedBy) next.admin_patched_by = String(patchedBy).trim();
  if (patchNote) next.admin_patch_note = String(patchNote).trim();

  // Refresh the embedded hash to match the new stored state.
  next.hashVersion = 1;
  next.hashCreatedAt = new Date().toISOString();
  next.hash = computeOrderHash(next);
  return next;
}

// ---------------------------------------------------------------------------
// LOCKDOWN MODE (block write actions during live/event week)
// ---------------------------------------------------------------------------

function getClientIp(req) {
  const xf = req?.headers?.["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  const real = req?.headers?.["x-real-ip"];
  if (real) return String(real).trim();
  return (req?.socket?.remoteAddress || "").trim();
}

function tokenFingerprint(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 6);
}

async function getEffectiveSettings() {
  const overrides = await kvHgetallSafe("settings:overrides");
  const env = {
    RESEND_FROM: RESEND_FROM,
    REPORTS_CC: process.env.REPORTS_CC || "",
    REPORTS_BCC: process.env.REPORTS_BCC || "",
    SITE_BASE_URL: process.env.SITE_BASE_URL || "",
    MAINTENANCE_ON: process.env.MAINTENANCE_ON === "true",
    MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || "",
    REPORTS_SEND_SEPARATE: String(process.env.REPORTS_SEND_SEPARATE ?? "true"),
    REPLY_TO,
    EVENT_START: process.env.EVENT_START || "",
    EVENT_END: process.env.EVENT_END || "",
    REPORT_ORDER_DAYS: process.env.REPORT_ORDER_DAYS || "",
    LOCKDOWN_MODE: process.env.LOCKDOWN_MODE || "off",
    LOCKDOWN_ALLOW_IPS: process.env.LOCKDOWN_ALLOW_IPS || "",
    LOCKDOWN_ALLOW_TOKEN_FPS: process.env.LOCKDOWN_ALLOW_TOKEN_FPS || "",
  };
  const effective = {
    ...env,
    ...overrides,
    MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true",
  };
  return { env, overrides, effective };
}

async function getLockdownConfig() {
  const { effective } = await getEffectiveSettings();

  const modeRaw = String(effective.LOCKDOWN_MODE || process.env.LOCKDOWN_MODE || "off")
    .trim()
    .toLowerCase();
  const mode = ["off", "admin", "all"].includes(modeRaw) ? modeRaw : "off";

  const allowIps = String(effective.LOCKDOWN_ALLOW_IPS || process.env.LOCKDOWN_ALLOW_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowTokenFps = String(
    effective.LOCKDOWN_ALLOW_TOKEN_FPS || process.env.LOCKDOWN_ALLOW_TOKEN_FPS || ""
  )
    .split(",")
    .map((s) => s.trim())
    .toLowerCase()
    .filter(Boolean);

  return { mode, allowIps, allowTokenFps };
}

async function lockdownAllowsBypass(req) {
  const { allowIps, allowTokenFps } = await getLockdownConfig();

  const ip = getClientIp(req);
  if (ip && allowIps.includes(ip)) return { ok: true, reason: "ip-allow" };

  const token =
    req?.headers?.["x-amaranth-admin-token"] || req?.headers?.["x-admin-token"] || "";
  const fp = tokenFingerprint(token);
  if (fp && allowTokenFps.includes(fp.toLowerCase())) return { ok: true, reason: "token-allow", fp };

  return { ok: false, reason: "not-allowed" };
}

// Call this from router BEFORE performing a write action.
// action: "admin-write" | "checkout-write"
async function assertNotLocked(req, action = "admin-write") {
  const { mode } = await getLockdownConfig();
  if (!mode || mode === "off") return;

  const blocksAdmin = mode === "admin" || mode === "all";
  const blocksCheckout = mode === "all";
  const shouldBlock =
    (action === "admin-write" && blocksAdmin) || (action === "checkout-write" && blocksCheckout);
  if (!shouldBlock) return;

  const bypass = await lockdownAllowsBypass(req);
  if (bypass.ok) return;

  const err = new Error(`LOCKDOWN: ${action} blocked`);
  err.code = "lockdown";
  throw err;
}

// Cached orders for the lifetime of a single lambda invocation
let _ordersCache = null;

// When admin tools patch stored orders, the warm lambda may still hold a cached
// copy. Expose a small helper so router.js can clear it after a patch.
export function clearOrdersCache() {
  _ordersCache = null;
}

// Load all orders with a few retries to be safer on cold starts
async function loadAllOrdersWithRetry(options = {}) {
  const { retries = 4, delayMs = 500 } = options;
  if (Array.isArray(_ordersCache)) return _ordersCache;

  let lastOrders = [];

  for (let attempt = 0; attempt < retries; attempt++) {
    const idx = await kvSmembersSafe("orders:index");
    const orders = [];
    for (const sid of idx) {
      const o = await kvGetSafe(`order:${sid}`, null);
      if (o) orders.push(o);
    }
    lastOrders = orders;

    if (orders.length > 0 || idx.length === 0) {
      _ordersCache = orders;
      return orders;
    }

    if (attempt < retries - 1) await sleep(delayMs);
  }

  _ordersCache = lastOrders;
  return lastOrders;
}

// --- Reporting / filtering helpers ---
function parseDateISO(s) {
  if (!s) return NaN;
  const d = Date.parse(s);
  return isNaN(d) ? NaN : d;
}
function parseYMD(s) {
  if (!s) return NaN;
  const d = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return isNaN(d) ? NaN : d;
}
function sortByDateAsc(arr, key = "date") {
  return (arr || []).slice().sort((a, b) => {
    const ta = parseDateISO(a?.[key]);
    const tb = parseDateISO(b?.[key]);
    return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
  });
}

// Base id helper: everything before the first colon
const baseKey = (s) => String(s || "").toLowerCase().split(":")[0];

// Legacy normalizer kept
const normalizeKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/:(adult|child|youth)$/i, "");

// ---- Report frequency normalizer (shared) ----
// NOTE: report-scheduler.js uses a richer normalizer; this is the legacy one
const VALID_FREQS = ["daily", "weekly", "biweekly", "monthly", "none"];
function normalizeReportFrequency(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "monthly";
  if (VALID_FREQS.includes(v)) return v;
  return "monthly";
}

function filterRowsByWindow(rows, { startMs, endMs }) {
  if (!rows?.length) return rows || [];
  return rows.filter((r) => {
    const t = parseDateISO(r.date);
    if (isNaN(t)) return false;
    if (startMs && t < startMs) return false;
    if (endMs && t >= endMs) return false;
    return true;
  });
}

// Apply category / item filters (used by /orders, /orders_csv, and send_item_report)
function applyItemFilters(rows, { category, item_id, item }) {
  let out = rows || [];

  if (category) {
    const cat = String(category).toLowerCase();
    out = out.filter((r) => String(r.category || "").toLowerCase() === cat);
  }

  if (item_id) {
    const wantRaw = String(item_id).toLowerCase();
    const wantBase = baseKey(wantRaw);
    const wantNorm = normalizeKey(wantRaw);

    out = out.filter((r) => {
      const raw = String(r._itemId || r.item_id || "").toLowerCase();
      const rawNorm = normalizeKey(raw);
      const keyBase = baseKey(r._itemId || r.item_id || "");
      const rowBase = r._itemBase || keyBase;

      return (
        raw === wantRaw ||
        rawNorm === wantNorm ||
        keyBase === wantBase ||
        rowBase === wantBase ||
        String(r._itemKey || "").toLowerCase() === wantNorm
      );
    });
  } else if (item) {
    const want = String(item).toLowerCase();
    out = out.filter((r) => String(r.item || "").toLowerCase().includes(want));
  }

  return out;
}

// --- Mail visibility helpers ---
const MAIL_LOG_KEY = "mail:lastlog";
const MAIL_LOG_LIST_KEY = "mail:logs";

async function recordMailLog(payload) {
  // Keep the single last-log (quick debug)
  try {
    await kv.set(MAIL_LOG_KEY, payload, { ex: 3600 });
  } catch {}

  // Also keep a rolling recent history for admin debug2 (debug_mail_recent)
  try {
    await kv.lpush(MAIL_LOG_LIST_KEY, payload);
    await kv.ltrim(MAIL_LOG_LIST_KEY, 0, 199); // keep last 200
  } catch {}
}
// --- Coverage text helper for chair reports ---
function formatCoverageRange({ startMs, endMs, rows }) {
  const fmt = (ms) =>
    new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  let start = typeof startMs === "number" && !isNaN(startMs) ? startMs : null;
  let end = typeof endMs === "number" && !isNaN(endMs) ? endMs - 1 : null;

  if ((start == null || end == null) && Array.isArray(rows) && rows.length) {
    const ts = rows.map((r) => parseDateISO(r.date)).filter((t) => !isNaN(t));
    if (ts.length) {
      const min = Math.min(...ts);
      const max = Math.max(...ts);
      if (start == null) start = min;
      if (end == null) end = max;
    }
  }

  if (start == null && end == null) return "";

  const startLabel = start != null ? fmt(start) : "beginning of recorded orders";
  const endLabel = end != null ? fmt(end) : "now";
  return `This report covers orders from ${startLabel} through ${endLabel}.`;
}

// --- Stripe helpers: always fetch the full line item list ---
async function fetchSessionAndItems(stripe, sid) {
  const s = await stripe.checkout.sessions.retrieve(sid, {
    expand: ["payment_intent", "customer_details"],
  });
  const liResp = await stripe.checkout.sessions.listLineItems(sid, {
    limit: 100,
    expand: ["data.price.product"],
  });
  const lineItems = liResp?.data || [];
  return { session: s, lineItems };
}

// ----- Chair email resolution -----
async function getChairEmailsForItemId(id) {
  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  try {
    const banquets = await kvGetSafe("banquets", []);
    if (Array.isArray(banquets)) {
      const b = banquets.find((x) => String(x?.id || "") === String(id));
      if (b) {
        const arr = Array.isArray(b.chairEmails)
          ? b.chairEmails
          : safeSplit(b.chairEmails || b?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  try {
    const addons = await kvGetSafe("addons", []);
    if (Array.isArray(addons)) {
      const a = addons.find((x) => String(x?.id || "") === String(id));
      if (a) {
        const arr = Array.isArray(a.chairEmails)
          ? a.chairEmails
          : safeSplit(a.chairEmails || a?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  const cfg = await kvHgetallSafe(`itemcfg:${id}`);
  const legacyArr = Array.isArray(cfg?.chairEmails)
    ? cfg.chairEmails
    : safeSplit(cfg?.chairEmails || "");
  return legacyArr;
}

// ----- order persistence helpers -----
// NOTE: accepts optional extra object (e.g. { mode: "live" })
async function saveOrderFromSession(sessionLike, extra = {}) {
  const stripe = await getStripe();
  if (!stripe) throw new Error("stripe-not-configured");

  const sid = typeof sessionLike === "string" ? sessionLike : sessionLike.id;
  const { session: s, lineItems } = await fetchSessionAndItems(stripe, sid);

  const lines = lineItems.map((li) => {
    const name = li.description || li.price?.product?.name || "Item";
    const qty = Number(li.quantity || 1);
    const unit = cents(li.price?.unit_amount || 0);
    const total = unit * qty;
    const meta = li.price?.product?.metadata || {};
    return {
      id: `${sid}:${li.id}`,
      itemName: name,
      qty,
      unitPrice: unit,
      gross: total,
      category: (meta.itemType || "").toLowerCase() || "other",

      attendeeId: meta.attendeeId || meta.attendee_id || "",
      attendeeName: meta.attendeeName || meta.attendee_name || "",
      attendeeTitle: meta.attendeeTitle || meta.attendee_title || "",
      attendeePhone: meta.attendeePhone || meta.attendee_phone || "",
      attendeeEmail: meta.attendeeEmail || meta.attendee_email || "",
      itemId: meta.itemId || meta.item_id || "",
      meta: {
        attendeeName: meta.attendeeName || "",
        attendeeTitle: meta.attendeeTitle || "",
        attendeePhone: meta.attendeePhone || "",
        attendeeEmail: meta.attendeeEmail || "",
        attendeeCourt:
          meta.attendeeCourt ||
          meta.attendeeCourtName ||
          meta.attendee_court ||
          meta.attendee_court_name ||
          meta.court ||
          meta.courtName ||
          meta.court_name ||
          "",
        attendeeCourtNumber:
          meta.attendeeCourtNumber ||
          meta.attendeeCourtNo ||
          meta.attendeeCourtNum ||
          meta.attendee_court_number ||
          meta.attendee_court_no ||
          meta.attendee_court_num ||
          meta.courtNumber ||
          meta.court_no ||
          meta.courtNo ||
          meta.courtNum ||
          "",
        attendeeNotes: meta.attendeeNotes || "",
        dietaryNote: meta.dietaryNote || "",
        corsageChoice: meta.corsageChoice || meta.corsage_choice || meta.corsageType || meta.corsage_type || meta.choice || meta.selection || meta.style || meta.color || "",
        corsageWear: meta.corsageWear || meta.corsage_wear || meta.wear || meta.wearStyle || "",
        corsageNote: meta.corsageNote || meta.corsage_note || "",
        itemNote:
        (meta.itemNote ||
          meta.item_note ||
          meta.notes ||
          meta.note ||
          meta.message ||
          "")
        ,
        attendeeAddr1: meta.attendeeAddr1 || "",
        attendeeAddr2: meta.attendeeAddr2 || "",
        attendeeCity: meta.attendeeCity || "",
        attendeeState: meta.attendeeState || "",
        attendeePostal: meta.attendeePostal || "",
        attendeeCountry: meta.attendeeCountry || "",
        priceMode: meta.priceMode || "",
        bundleQty: meta.bundleQty || "",
        bundleTotalCents: meta.bundleTotalCents || "",
        itemType: meta.itemType || "",
      },
      notes: "",
    };
  });

  // ---------------------------------------------------------------------------
  // Attendee name normalization (prevents duplicate attendee boxes on Order page)
  // ---------------------------------------------------------------------------
  try {
    const bestNameById = {};
    for (const ln of lines) {
      const aid = String(ln?.attendeeId || "").trim();
      if (!aid) continue;
      const n =
        String(ln?.attendeeName || ln?.meta?.attendeeName || "").trim() ||
        String(ln?.meta?.attendee_name || "").trim();
      if (!n) continue;
      const prev = bestNameById[aid] || "";
      if (!prev || n.length > prev.length) bestNameById[aid] = n;
    }
    for (const ln of lines) {
      const aid = String(ln?.attendeeId || "").trim();
      if (!aid) continue;
      const best = bestNameById[aid] || "";
      if (!best) continue;
      ln.attendeeName = best;
      ln.meta = ln.meta && typeof ln.meta === "object" ? ln.meta : {};
      ln.meta.attendeeName = best;
      ln.meta.attendee_name = best; // snake_case compatibility
    }
  } catch {}

  const md = s.metadata || {};
  const purchaserFromMeta = {
    name: (md.purchaser_name || "").trim(),
    email: (md.purchaser_email || "").trim(),
    phone: (md.purchaser_phone || "").trim(),
    title: (md.purchaser_title || "").trim(),
    address1: (md.purchaser_addr1 || "").trim(),
    address2: (md.purchaser_addr2 || "").trim(),
    city: (md.purchaser_city || "").trim(),
    state: (md.purchaser_state || "").trim(),
    postal: (md.purchaser_postal || "").trim(),
    country: (md.purchaser_country || "").trim(),
  };

  let order = {
    id: sid,
    created: Date.now(),
    payment_intent:
      typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || "",
    charge: null,
    currency: s.currency || "usd",
    amount_total: cents(s.amount_total || 0),
    customer_email: (s.customer_details?.email || purchaserFromMeta.email || "").trim(),
    purchaser: {
      name: purchaserFromMeta.name || s.customer_details?.name || "",
      email: purchaserFromMeta.email || s.customer_details?.email || "",
      phone: purchaserFromMeta.phone || s.customer_details?.phone || "",
      title: purchaserFromMeta.title || "",
      address1: purchaserFromMeta.address1 || "",
      address2: purchaserFromMeta.address2 || "",
      city: purchaserFromMeta.city || "",
      state: purchaserFromMeta.state || "",
      postal: purchaserFromMeta.postal || "",
      country: purchaserFromMeta.country || "",
    },
    lines,
    fees: { pct: 0, flat: 0 },
    refunds: [],
    refunded_cents: 0,
    status: "paid",
  };

  if (extra && typeof extra === "object") order = { ...order, ...extra };

  const piId = order.payment_intent;
  if (piId) {
    const stripe2 = await getStripe();
    const pi = await stripe2?.paymentIntents
      .retrieve(piId, { expand: ["charges.data"] })
      .catch(() => null);
    if (pi?.charges?.data?.length) order.charge = pi.charges.data[0].id;
  }

  // Attach immutable hash at end
  order = attachImmutableOrderHash(order);

  await kvSetSafe(`order:${order.id}`, order);
  await kvSaddSafe("orders:index", order.id);
  return order;
}

async function applyRefundToOrder(chargeId, refund) {
  const ids = await kvSmembersSafe("orders:index");
  for (const sid of ids) {
    const key = `order:${sid}`;
    const o = await kvGetSafe(key, null);
    if (!o) continue;
    if (o.charge === chargeId || o.payment_intent === refund.payment_intent) {
      const entry = {
        id: refund.id,
        amount: cents(refund.amount || 0),
        charge: refund.charge || chargeId,
        created: refund.created ? refund.created * 1000 : Date.now(),
      };
      o.refunds = Array.isArray(o.refunds) ? o.refunds : [];
      o.refunds.push(entry);
      o.refunded_cents = (o.refunded_cents || 0) + entry.amount;
      o.status = o.refunded_cents >= o.amount_total ? "refunded" : "partial_refund";
      await kvSetSafe(key, o);
      return true;
    }
  }
  return false;
}

// --- Flatten an order into report rows (CSV-like) ---
function flattenOrderToRows(o) {
  const rows = [];
  const mode = (o.mode || "test").toLowerCase();

  (o.lines || []).forEach((li) => {
    const net = li.gross;
    const rawId = li.itemId || "";
    const base = baseKey(rawId);

    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: li.meta?.attendeeName || "",
      attendee_title: li.meta?.attendeeTitle || "",
      attendee_email: li.meta?.attendeeEmail || "",
      attendee_phone: li.meta?.attendeePhone || "",
            court: li.meta?.attendeeCourt || li.meta?.attendeeCourtName || li.meta?.attendee_court || li.meta?.attendee_court_name || li.meta?.court || li.meta?.courtName || li.meta?.court_name || li.meta?.attendeeCourtName || "",
            court_number: li.meta?.attendeeCourtNumber || li.meta?.attendeeCourtNo || li.meta?.attendeeCourtNum || li.meta?.attendee_court_number || li.meta?.attendee_court_no || li.meta?.attendee_court_num || li.meta?.courtNumber || li.meta?.court_no || li.meta?.courtNo || li.meta?.courtNum || "",
      attendee_addr1: li.meta?.attendeeAddr1 || "",
      attendee_addr2: li.meta?.attendeeAddr2 || "",
      attendee_city: li.meta?.attendeeCity || "",
      attendee_state: li.meta?.attendeeState || "",
      attendee_postal: li.meta?.attendeePostal || "",
      attendee_country: li.meta?.attendeeCountry || "",
      category: li.category || "other",
      item: li.itemName || "",
      item_id: rawId,
      corsage_wear: /(corsage|boutonniere)/.test(base) ? (li.meta?.corsageWear || li.meta?.corsage_wear || "") : "",
      qty: li.qty || 1,
      price: (li.unitPrice || 0) / 100,
      gross: (li.gross || 0) / 100,
      fees: 0,
      net: (net || 0) / 100,
      status: o.status || "paid",
      notes:
        li.category === "banquet"
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : [li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote]
          .filter(Boolean)
          .join("; ")
          ,
      _itemId: rawId,
      _itemBase: base,
      _itemKey: normalizeKey(rawId),
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id,
      mode,
    });
  });

  const feeLine = (o.lines || []).find((li) => /processing fee/i.test(li.itemName || ""));
  if (feeLine) {
    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "",
      attendee_title: "",
      attendee_email: "",
      attendee_phone: "",
      court: "",
      court_number: "",
      attendee_addr1: "",
      attendee_addr2: "",
      attendee_city: "",
      attendee_state: "",
      attendee_postal: "",
      attendee_country: "",
      category: "other",
      item: feeLine.itemName || "Processing Fee",
      item_id: "",
      qty: feeLine.qty || 1,
      price: (feeLine.unitPrice || 0) / 100,
      gross: (feeLine.gross || 0) / 100,
      net: (feeLine.gross || 0) / 100,
      fees: 0,
      status: o.status || "paid",
      notes: "",
      _itemId: "",
      _itemBase: "",
      _itemKey: "",
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id,
      mode,
    });
  }
  return rows;
}

// --- Helper to estimate Stripe fee from items + shipping ---
function computeStripeProcessingFeeFromLines(
  lines,
  { stripePct = 0.029, stripeFlatCents = 30 } = {}
) {
  if (!Array.isArray(lines) || !lines.length) return 0;

  let itemsSubtotal = 0;
  let shipping = 0;

  for (const li of lines) {
    const name = li.itemName || "";
    const qty = Number(li.qty || 1);
    const lineCents = Number(li.unitPrice || 0) * qty;
    const cat = String(li.category || "").toLowerCase();
    const itemId = String(li.itemId || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();

    const isProcessingFee =
      itemId === "processing-fee" ||
      ((cat === "fee" || metaType === "fee" || metaType === "other") &&
        /processing\s*fee/i.test(name));
    const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);
    const isShipping = cat === "shipping" || metaType === "shipping" || itemId === "shipping";

    if (isProcessingFee || isIntlFee) continue;
    if (isShipping) {
      shipping += lineCents;
      continue;
    }
    itemsSubtotal += lineCents;
  }

  const base = itemsSubtotal + shipping;
  if (base <= 0) return 0;
  return Math.round(base * stripePct + stripeFlatCents);
}

// -------- Email rendering + sending (receipts) --------
function absoluteUrl(path = "/") {
  const base = (process.env.SITE_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

function renderOrderEmailHTML(order) {
  const money = (c) =>
    (Number(c || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const logoUrl = absoluteUrl("/assets/img/receipt_logo.svg");
  const purchaserName = order?.purchaser?.name || "Purchaser";
  const lines = order.lines || [];

  const topCatalog = [];
  const attendeeGroups = {};
  let processingFeeCents = 0;
  let intlFeeCents = 0;

  (lines || []).forEach((li) => {
    const name = li.itemName || "";
    const qty = Number(li.qty || 1);
    const lineCents = Number(li.unitPrice || 0) * qty;
    const cat = String(li.category || "").toLowerCase();
    const itemId = String(li.itemId || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();

    const isProcessingFee =
      itemId === "processing-fee" ||
      ((cat === "fee" || metaType === "fee" || metaType === "other") &&
        /processing\s*fee/i.test(name));
    const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);

    if (isProcessingFee) {
      processingFeeCents += lineCents;
      return;
    }
    if (isIntlFee) {
      intlFeeCents += lineCents;
      return;
    }

    const isBanquet = cat === "banquet" || /banquet/i.test(name);
    const isAddon = cat === "addon" || /addon/i.test(li.meta?.itemType || "") || /addon/i.test(name);

    if (isBanquet || isAddon) {
      const attName = (li.meta && li.meta.attendeeName) || purchaserName;
      (attendeeGroups[attName] ||= []).push(li);
    } else {
      topCatalog.push(li);
    }
  });

  const renderTable = (rows) => {
    const bodyRows = rows
      .map((li) => {
        const cat = String(li.category || "").toLowerCase();
        const isBanquet = cat === "banquet" || /banquet/i.test(li.itemName || "");
        const itemIdLower = String(li.itemId || "").toLowerCase();

        // Corsage: append choice + wear style directly on the line item label
        let itemLabel = li.itemName || "";
        // Pre-Registration: append Voting / Non-Voting to label + notes (receipt-safe)
        const itemNameLower = String(li.itemName || "").toLowerCase();
        const isPreReg =
          (itemIdLower.includes("pre") && (itemIdLower.includes("reg") || itemIdLower.includes("registration"))) ||
          itemNameLower.includes("pre-registration") ||
          itemNameLower.includes("pre registration") ||
          itemNameLower.includes("pre reg") ||
          itemNameLower.includes("prereg");

        let preRegVotingLabel = "";
        if (isPreReg) {
          const blob = [
            li.meta?.voting_status,
            li.meta?.votingStatus,
            li.meta?.voting,
            li.meta?.isVoting,
            li.meta?.attendeeTitle,
            li.meta?.attendeeNotes,
            li.meta?.itemNote,
            itemLabel,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          if (/non\s*-?\s*voting/.test(blob) || /nonvoting/.test(blob)) preRegVotingLabel = "Non-Voting";
          else if (/\bvoting\b/.test(blob)) preRegVotingLabel = "Voting";

          if (preRegVotingLabel) {
            const il = String(itemLabel || "").toLowerCase();
            if (!il.includes("non-voting") && !il.includes("nonvoting") && !il.includes("voting")) {
              itemLabel += ` (${preRegVotingLabel})`;
            }
          }
        }

        if (itemIdLower === "corsage") {
          const rawChoice = String(li.meta?.corsageChoice || li.meta?.corsage_choice || "").trim();
          const isCustom = !!li.meta?.corsageIsCustom || /custom/i.test(rawChoice);
          const choiceLabel = isCustom ? "Custom" : (rawChoice || "");
          const wear = String(li.meta?.corsageWear || li.meta?.corsage_wear || "").toLowerCase();
          const wearLabel = wear === "wrist" ? "Wrist" : (wear === "pin" ? "Pin-on" : "");

          const baseLower = itemLabel.toLowerCase();

          // Only append choice if it's not already present in the existing itemName
          if (choiceLabel && !baseLower.includes(choiceLabel.toLowerCase())) {
            itemLabel += ` (${choiceLabel.replace(/</g,"&lt;")})`;
          }
}

        const preRegNotes =
          isPreReg && preRegVotingLabel ? `Member: ${preRegVotingLabel}` : "";

        const notes = isBanquet
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : [li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote, preRegNotes]
              .filter(Boolean)
              .join("; ");
        const notesRow = notes
          ? `<div style="font-size:12px;color:#444;margin-top:2px">Notes: ${String(notes).replace(
              /</g,
              "&lt;"
            )}</div>`
          : "";
        const lineTotal = Number(li.unitPrice || 0) * Number(li.qty || 1);
        return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee">
            ${itemLabel}${notesRow}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(
            li.qty || 1
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(
            li.unitPrice || 0
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(
            lineTotal
          )}</td>
        </tr>`;
      })
      .join("");

    const subtotal = rows.reduce((s, li) => s + Number(li.unitPrice || 0) * Number(li.qty || 1), 0);

    return `
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Item</th>
            <th style="text-align:center;padding:8px;border-bottom:1px solid #ddd">Qty</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #ddd">Price</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #ddd">Line</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">Subtotal</td>
            <td style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">${money(
              subtotal
            )}</td>
          </tr>
        </tfoot>
      </table>`;
  };

  const topCatalogHtml = topCatalog.length
    ? `
      <div style="margin-top:14px">
        <div style="font-weight:700;margin:8px 0 6px">${purchaserName} — Catalog Items</div>
        ${renderTable(topCatalog)}
      </div>`
    : "";

  const attendeeHtml = Object.entries(attendeeGroups)
    .map(
      ([attName, list]) => `
    <div style="margin-top:14px">
      <div style="font-weight:700;margin:8px 0 6px">${attName} — Banquets & Addons</div>
      ${renderTable(list)}
    </div>`
    )
    .join("");

  const { itemsSubtotalCents, shippingCents } = (function () {
    let itemsSubtotal = 0;
    let shipping = 0;

    for (const li of lines) {
      const name = li.itemName || "";
      const qty = Number(li.qty || 1);
      const lineCents = Number(li.unitPrice || 0) * qty;
      const cat = String(li.category || "").toLowerCase();
      const itemId = String(li.itemId || "").toLowerCase();
      const metaType = String(li.meta?.itemType || "").toLowerCase();

      const isProcessingFee =
        itemId === "processing-fee" ||
        ((cat === "fee" || metaType === "fee" || metaType === "other") &&
          /processing\s*fee/i.test(name));
      const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);
      const isShipping = cat === "shipping" || metaType === "shipping" || itemId === "shipping";

      if (isProcessingFee || isIntlFee) continue;
      if (isShipping) {
        shipping += lineCents;
        continue;
      }
      itemsSubtotal += lineCents;
    }

    return { itemsSubtotalCents: itemsSubtotal, shippingCents: shipping };
  })();

  const grandTotalCents = itemsSubtotalCents + shippingCents + processingFeeCents + intlFeeCents;
  const totalCents = grandTotalCents > 0 ? grandTotalCents : Number(order.amount_total || 0);

  const shippingRow =
    shippingCents > 0
      ? `
      <tr>
        <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">Shipping &amp; Handling</td>
        <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(
          shippingCents
        )}</td>
      </tr>`
      : "";

  const processingRow =
    processingFeeCents > 0
      ? `
      <tr>
        <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">Online Processing Fee</td>
        <td style="text-align:right;padding:8px;border-top:1px solid:#eee">${money(
          processingFeeCents
        )}</td>
      </tr>`
      : "";

  const intlRow =
    intlFeeCents > 0
      ? `
      <tr>
        <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">International Card Processing Fee (3%)</td>
        <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(
          intlFeeCents
        )}</td>
      </tr>`
      : "";

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;color:#111;margin:0;">
  <div style="max-width:720px;margin:0 auto;padding:16px 20px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <img src="${absoluteUrl("/assets/img/receipt_logo.svg")}" alt="Logo" style="height:28px;max-width:160px;object-fit:contain" />
      <div>
        <div style="font-size:18px;font-weight:800">Grand Court of PA — Order of the Amaranth</div>
        <div style="font-size:14px;color:#555">Order #${order.id}</div>
      </div>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-top:8px">
      <div style="font-weight:700;margin-bottom:8px">Purchaser</div>
      <div>${order?.purchaser?.name || "Purchaser"}</div>
      <div>${order.customer_email || ""}</div>
      <div>${order.purchaser?.phone || ""}</div>
    </div>

    <h2 style="margin:16px 0 8px">Order Summary</h2>
    ${topCatalogHtml}
    ${attendeeHtml || "<p>No items.</p>"}

    <table style="width:100%;border-collapse:collapse;margin-top:12px">
      <tfoot>
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid:#eee">Subtotal</td>
          <td style="text-align:right;padding:8px;border-top:1px solid:#eee">${(itemsSubtotalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
        </tr>
        ${shippingRow}
        ${processingRow}
        ${intlRow}
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:2px solid:#ddd;font-weight:700">Total</td>
          <td style="text-align:right;padding:8px;border-top:2px solid:#ddd;font-weight:700">${(totalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
        </tr>
      </tfoot>
    </table>

    <p style="color:#666;font-size:12px;margin-top:12px">Thank you for your order!</p>
  </div>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Receipt XLSX backup (standard columns + year/month/day) → emailed to EMAIL_RECEIPTS
// ---------------------------------------------------------------------------

const RECEIPT_XLSX_HEADERS = [
  "year",
  "month",
  "day",
  "order_id",
  "date",
  "mode",
  "purchaser_name",
  "purchaser_email",
  "purchaser_phone",
  "attendee",
  "attendee_title",
  "attendee_email",
  "attendee_phone",
  "category",
  "item",
  "item_id",
  "qty",
  "unit_price",
  "line_total",
  "status",
  "notes",
  "_pi",
  "_charge",
  "_session",
];

const RECEIPT_XLSX_HEADER_LABELS = {
  year: "Year",
  month: "Month",
  day: "Day",
  order_id: "Order ID",
  date: "Date",
  mode: "Mode",
  purchaser_name: "Purchaser",
  purchaser_email: "Purchaser Email",
  purchaser_phone: "Purchaser Phone",
  attendee: "Attendee",
  attendee_title: "Title",
  attendee_email: "Attendee Email",
  attendee_phone: "Attendee Phone",
  category: "Category",
  item: "Item",
  item_id: "Item ID",
  qty: "Qty",
  unit_price: "Unit Price",
  line_total: "Line Total",
  status: "Status",
  notes: "Notes",
  _pi: "Payment Intent",
  _charge: "Charge",
  _session: "Session ID",
};

function deriveYMDParts(createdMs) {
  const d = new Date(Number(createdMs || Date.now()));
  const iso = d.toISOString();
  const day = iso.slice(0, 10);
  const year = day.slice(0, 4);
  const month = day.slice(0, 7);
  return { year, month, day, iso };
}

function buildReceiptXlsxRows(order) {
  const o = order || {};
  const { year, month, day, iso } = deriveYMDParts(o.created || Date.now());
  const mode = String(o.mode || "test").toLowerCase();
  const purchaserName =
    String(o?.purchaser?.name || "").trim() || String(o.customer_email || "").trim();
  const purchaserEmail = String(o?.purchaser?.email || o.customer_email || "").trim();
  const purchaserPhone = String(o?.purchaser?.phone || "").trim();
  const status = String(o.status || "paid");

  const rows = [];
  for (const li of o.lines || []) {
    const qty = Number(li?.qty || 1);
    const unit = Number(li?.unitPrice || 0);
    const lineCents = unit * qty;

    const cat = String(li?.category || "other").toLowerCase();
    const itemId = String(li?.itemId || "");
    const itemName = String(li?.itemName || "");

    const isBanquet = cat === "banquet" || /banquet/i.test(itemName);
    const notes = isBanquet
      ? [li?.meta?.attendeeNotes, li?.meta?.dietaryNote].filter(Boolean).join("; ")
      : [li?.meta?.corsageChoice, li?.meta?.itemNote, li?.meta?.corsageNote].filter(Boolean).join("; ");

    rows.push({
      year,
      month,
      day,
      order_id: String(o.id || ""),
      date: iso,
      mode,
      purchaser_name: purchaserName,
      purchaser_email: purchaserEmail,
      purchaser_phone: purchaserPhone,
      attendee: String(li?.meta?.attendeeName || ""),
      attendee_title: String(li?.meta?.attendeeTitle || ""),
      attendee_email: String(li?.meta?.attendeeEmail || ""),
      attendee_phone: String(li?.meta?.attendeePhone || ""),
      category: cat,
      item: itemName,
      item_id: itemId,
      qty: qty,
      unit_price: Number((unit / 100).toFixed(2)),
      line_total: Number((lineCents / 100).toFixed(2)),
      status,
      notes: String(notes || ""),
      _pi: String(o.payment_intent || ""),
      _charge: String(o.charge || ""),
      _session: String(o.id || ""),
    });
  }

  if (!rows.length) {
    const blank = {};
    for (const h of RECEIPT_XLSX_HEADERS) blank[h] = "";
    blank.year = year;
    blank.month = month;
    blank.day = day;
    blank.order_id = String(o.id || "");
    blank.date = iso;
    blank.mode = mode;
    blank.purchaser_email = purchaserEmail;
    blank.status = status;
    rows.push(blank);
  }

  return rows;
}

// Idempotency: don’t re-send XLSX backup for the same order
function receiptXlsxSentKey(orderId) {
  return `order:${String(orderId || "").trim()}:receipt_xlsx_sent`;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function buildCSV(rows) {
  if (!Array.isArray(rows) || !rows.length) return "\uFEFF";
  const headers = Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.join(",")];
  for (const r of rows) out.push(headers.map((h) => esc(r[h])).join(","));
  return "\uFEFF" + out.join("\n");
}

function buildCSVSelected(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.join(",")];
  for (const r of rows || []) out.push(headers.map((h) => esc(r?.[h])).join(","));
  return "\uFEFF" + out.join("\n");
}

// ---------------------------------------------------------------------------
// XLSX helper: objects → XLSX buffer
// ---------------------------------------------------------------------------

async function objectsToXlsxBuffer(
  columns,
  rows,
  headerLabels = {},
  sheetName = "Sheet1",
  options = {}
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  const {
    spacerRows = false, // Step 1: add a blank spacer row after each data row
    autoFit = true,     // Step 3: expand columns to the longest value
    minColWidth = 10,
    maxColWidth = 60,
    padding = 2,
  } = options || {};

  const cols = (columns || []).map((key) => ({
    header: headerLabels[key] || key,
    key,
    // initial width; may be overridden by autoFit below
    width: Math.min(maxColWidth, Math.max(minColWidth, String(headerLabels[key] || key).length + padding)),
  }));

  ws.columns = cols;

  for (const r of rows || []) {
    const obj = {};
    for (const c of columns || []) obj[c] = r?.[c] ?? "";
    ws.addRow(obj);
    if (spacerRows) ws.addRow({});
  }

  ws.getRow(1).font = { bold: true };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, cols.length) },
  };

  if (autoFit) {
    ws.columns.forEach((col) => {
      let longest = 0;

      col.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell?.value;
        let s = "";

        if (v == null) s = "";
        else if (typeof v === "string") s = v;
        else if (typeof v === "number") s = String(v);
        else if (typeof v === "boolean") s = v ? "TRUE" : "FALSE";
        else if (typeof v === "object") {
          if (v.richText) s = v.richText.map((x) => x.text).join("");
          else if (v.text != null) s = String(v.text);
          else if (v.formula) s = String(v.result ?? v.formula);
          else s = String(v);
        } else s = String(v);

        if (s.length > longest) longest = s.length;
      });

      col.width = Math.min(maxColWidth, Math.max(minColWidth, longest + padding));
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

// ---------------------------------------------------------------------------
// Receipt XLSX backup sender
// ---------------------------------------------------------------------------

async function sendReceiptXlsxBackup(order) {
  if (!resend || !EMAIL_RECEIPTS) return { ok: false, reason: "not-configured" };

  const orderId = String(order?.id || "").trim();
  if (!orderId) return { ok: false, reason: "missing-order-id" };

  const already = await kvGetSafe(receiptXlsxSentKey(orderId), null);
  if (already) return { ok: true, skipped: true, reason: "already-sent" };

  const rows = buildReceiptXlsxRows(order);
  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipt"
  );

  // ✅ ATTACHMENT HARDENING (ExcelJS can return ArrayBuffer)
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  const mode = String(order?.mode || "test").toLowerCase();
  const purchaserEmail = String(order?.purchaser?.email || order?.customer_email || "").trim();

  const subject = `Receipt XLSX backup — ${orderId}${mode ? ` (${mode})` : ""}`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
      <h2 style="margin:0 0 6px;">Receipt Backup (XLSX)</h2>
      <div>Order ID: <b>${orderId.replace(/</g, "&lt;")}</b></div>
      ${purchaserEmail ? `<div>Purchaser: <b>${purchaserEmail.replace(/</g, "&lt;")}</b></div>` : ""}
      <div style="margin-top:10px;color:#555;font-size:12px;">
        Automated backup copy in a standard spreadsheet format (stable headers &amp; order).
      </div>
    </div>
  `;

  const from = RESEND_FROM || "pa_sessions@yahoo.com";

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject: emailSubject,
    html,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipt-${mode || "test"}-${orderId}.xlsx`,
        content: xlsxBuf,
        // optional hints; safe if ignored
        content_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };

  const throttleMs = parseInt(process.env.REPORTS_THROTTLE_MS || "0", 10);
  if (throttleMs > 0 && Number.isFinite(throttleMs)) {
    await sleep(throttleMs);
  }

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipt:xlsx-backup:${orderId}`
  );

  if (retry.ok) {
    const sendResult = retry.result;
    await kvSetSafe(receiptXlsxSentKey(orderId), {
      sentAt: new Date().toISOString(),
      to: EMAIL_RECEIPTS,
      mode,
      resultId: sendResult?.id || null,
    });

    await recordMailLog({
      ts: Date.now(),
      from,
      to: [EMAIL_RECEIPTS],
      subject,
      orderId: order?.id || "",
      resultId: sendResult?.id || null,
      status: "queued",
      kind: "receipt-xlsx-backup",
      attachment: {
        filename: `receipt-${mode || "test"}-${orderId}.xlsx`,
        bytes: xlsxBuf.length,
      },
    });

    return { ok: true };
  }

  const err = retry.error;
  await recordMailLog({
    ts: Date.now(),
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    orderId: order?.id || "",
    resultId: null,
    status: "error",
    kind: "receipt-xlsx-backup",
    error: String(err?.message || err),
  });

  return { ok: false, error: err?.message || String(err) };
}

// ---------------------------------------------------------------------------
// Order receipts sender (main receipt email + optional admin copies)
// ---------------------------------------------------------------------------

async function sendOrderReceipts(order, { adminEmail } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };

  const purchaserEmail = String(order?.customer_email || order?.purchaser?.email || "").trim();
  const to = purchaserEmail ? [purchaserEmail] : [];
  const bcc = [];

  // If you want every order copied to a single admin inbox, pass adminEmail in
  const admin = String(adminEmail || "").trim();
  if (admin) bcc.push(admin);

  if (!to.length && !bcc.length) return { ok: false, error: "no-recipient" };

  const from = RESEND_FROM || "pa_sessions@yahoo.com";
  const subject = `Receipt — Order ${order?.id || ""}`.trim();
  const html = renderOrderEmailHTML(order);

  const payload = {
    from,
    to: to.length ? to : bcc,
    bcc: to.length && bcc.length ? bcc : undefined,
    subject,
    html,
    reply_to: REPLY_TO || undefined,
  };

  const retry = await sendWithRetry(() => resend.emails.send(payload), `receipt:${order?.id || ""}`);

  if (retry.ok) {
    const sendResult = retry.result;
    await recordMailLog({
      ts: Date.now(),
      from,
      to: [...to, ...bcc],
      subject,
      orderId: order?.id || "",
      resultId: sendResult?.id || null,
      status: "queued",
      kind: "receipt",
    });
    return { ok: true, resultId: sendResult?.id || null };
  }

  const err = retry.error;
  await recordMailLog({
    ts: Date.now(),
    from,
    to: [...to, ...bcc],
    subject,
    orderId: order?.id || "",
    resultId: null,
    status: "error",
    kind: "receipt",
    error: String(err?.message || err),
  });

  return { ok: false, error: err?.message || String(err) };
}

// ---------------------------------------------------------------------------
// Attendee roster collector (used by reports)
// ---------------------------------------------------------------------------

function collectAttendeesFromOrders(
  orders,
  { includeAddress = false, categories = [], startMs, endMs } = {}
) {
  const cats = (categories || []).map((c) => String(c || "").toLowerCase()).filter(Boolean);

  const allRows = [];
  for (const o of orders || []) {
    const rows = flattenOrderToRows(o);
    for (const r of rows) {
      const t = parseDateISO(r.date);
      if (startMs && !isNaN(t) && t < startMs) continue;
      if (endMs && !isNaN(t) && t >= endMs) continue;

      if (cats.length) {
        const rc = String(r.category || "").toLowerCase();
        if (!cats.includes(rc)) continue;
      }

      const base = {
        date: r.date,
        attendee: r.attendee,
        attendee_title: r.attendee_title,
        attendee_phone: r.attendee_phone,
        attendee_email: r.attendee_email,
        court: r.court,
        court_number: r.court_number,
        item: r.item,
        item_id: r.item_id,
        qty: r.qty,
        notes: r.notes,
      };

      if (includeAddress) {
        allRows.push({
          ...base,
          attendee_addr1: r.attendee_addr1,
          attendee_addr2: r.attendee_addr2,
          attendee_city: r.attendee_city,
          attendee_state: r.attendee_state,
          attendee_postal: r.attendee_postal,
          attendee_country: r.attendee_country,
        });
      } else {
        allRows.push(base);
      }
    }
  }

  return allRows;
}

// ---------------------------------------------------------------------------
// Chair report sender (attachment-hardened + scheduled_at safety)
// ---------------------------------------------------------------------------

async function sendItemReportEmailInternal({
  kind,
  id,
  label,
  scope = "current-month",
  startDate,
  endDate,
  startMs: explicitStartMs,
  endMs: explicitEndMs,
  scheduledAt,
  scheduled_at,

  // ✅ ADD THIS
  mode,

  // test tools
  toOverride,
  subjectPrefix,
  previewOnly,
} = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!kind || !id) return { ok: false, error: "missing-kind-or-id" };

  const from = RESEND_FROM || "pa_sessions@yahoo.com";

  // we still accept it, but we won't pass scheduled_at when attachments are present
  let scheduledAtIso = (scheduled_at || scheduledAt || "").trim();
  if (scheduledAtIso) {
    const t = Date.parse(scheduledAtIso);
    if (isNaN(t)) {
      console.warn("[sendItemReportEmailInternal] invalid scheduled time:", scheduledAtIso);
      scheduledAtIso = "";
    } else {
      if (t <= Date.now() + 30 * 1000) scheduledAtIso = "";
      else scheduledAtIso = new Date(t).toISOString();
    }
  }

  const orders = await loadAllOrdersWithRetry();

  // ✅ Filter orders by report channel (test/live_test/live) when provided
  const normMode = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s === "live-test" || s === "livetest") return "live_test";
    if (s === "test" || s === "live_test" || s === "live") return s;
    return "";
  };

  const wantMode = normMode(mode);
  const ordersForMode = wantMode
    ? (orders || []).filter((o) => {
        const m = normMode(o?.mode || o?.orderMode || o?.order_channel || o?.channel);
        return m === wantMode;
      })
    : orders;


  let startMs =
    typeof explicitStartMs === "number" && !isNaN(explicitStartMs) ? explicitStartMs : undefined;
  let endMs = typeof explicitEndMs === "number" && !isNaN(explicitEndMs) ? explicitEndMs : undefined;

  if (scope === "current-month" && startMs == null && endMs == null) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    startMs = start.getTime();
    endMs = Date.now() + 1;
  }

  if (scope === "custom" && startMs == null && endMs == null) {
    if (startDate) {
      const dStart = parseYMD(startDate);
      if (!isNaN(dStart)) startMs = dStart;
    }
    if (endDate) {
      const dEnd = parseYMD(endDate);
      if (!isNaN(dEnd)) endMs = dEnd + 24 * 60 * 60 * 1000;
    }
  }

  const base = baseKey(id);
  const includeAddressForThisItem = base === "pre-reg" || base === "directory" || base === "proceedings";
  const isLoveGiftBase = /(^|[-_])(love|gift|lovegift|love-gift)s?($|[-_])/.test(base);
  const isCorsageBase = /(corsage|boutonniere)/.test(base);
  const isBanquetKind = String(kind || "").toLowerCase() === "banquet";
  const isPreRegBase = base === "pre-reg";
  const isDirectoryBase = base === "directory";
  const isProceedingsBase = base === "proceedings";

  const rosterAll = collectAttendeesFromOrders(ordersForMode, {
    includeAddress: includeAddressForThisItem,
    categories: [String(kind).toLowerCase()],
    startMs,
    endMs,
  });

  const wantBase = (s) => String(s || "").toLowerCase().split(":")[0];
  const filtered = rosterAll.filter(
    (r) =>
      wantBase(r.item_id) === wantBase(id) ||
      (!r.item_id &&
        label &&
        String(r.item || "").toLowerCase().includes(String(label).toLowerCase()))
  );

  let EMAIL_COLUMNS = ["#", "date", "attendee", "attendee_title", "attendee_phone", "item", "qty", "notes"];
  let EMAIL_HEADER_LABELS = {
    "#": "#",
    date: "Date",
    attendee: "Attendee",
    attendee_title: "Title",
    attendee_phone: "Phone",
    item: "Item",
    qty: "Qty",
    notes: "Notes",
  };

  if (includeAddressForThisItem) {
    EMAIL_COLUMNS = [
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
      "item",
      "qty",
      "notes",
    ];
    EMAIL_HEADER_LABELS = {
      "#": "#",
      date: "Date",
      attendee: "Attendee",
      attendee_title: "Title",
      attendee_phone: "Phone",
      attendee_email: "Email",
      attendee_addr1: "Address 1",
      attendee_addr2: "Address 2",
      attendee_city: "City",
      attendee_state: "State",
      attendee_postal: "Postal",
      attendee_country: "Country",
      item: "Item",
      qty: "Qty",
      notes: "Notes",
    };
  }
  if (isLoveGiftBase && !isCorsageBase) {
    EMAIL_COLUMNS = (EMAIL_COLUMNS || []).flatMap((c) =>
      c === "item" ? ["item_name", "item_price"] : [c]
    );
    const lbl = { ...EMAIL_HEADER_LABELS };
    delete lbl.item;
    lbl.item_name = "Item";
    lbl.item_price = "Price";
    EMAIL_HEADER_LABELS = lbl;
  }

  // Banquets: include Court and Court #
  if (isBanquetKind) {
    const cols = Array.isArray(EMAIL_COLUMNS) ? [...EMAIL_COLUMNS] : [];
    const insertAfterKey = "attendee_phone";
    const afterIdx = cols.indexOf(insertAfterKey);
    const want = ["court", "court_number"];
    // Insert in a stable spot near attendee info
    for (let i = want.length - 1; i >= 0; i--) {
      const key = want[i];
      if (cols.includes(key)) continue;
      if (afterIdx >= 0) cols.splice(afterIdx + 1, 0, key);
      else cols.push(key);
    }
    EMAIL_COLUMNS = cols;
    EMAIL_HEADER_LABELS = {
      ...EMAIL_HEADER_LABELS,
      court: "Court",
      court_number: "Court #",
    };
  }

  // Pre-Registration / Printed Directory / Proceedings: include Court and Court #
  // (These are attendee-based but are not "banquet" kind, so they need their own injection.)
  if (isPreRegBase || isDirectoryBase || isProceedingsBase) {
    const cols = Array.isArray(EMAIL_COLUMNS) ? [...EMAIL_COLUMNS] : [];
    const insertAfterKey = "attendee_phone";
    const afterIdx = cols.indexOf(insertAfterKey);
    const want = ["court", "court_number"];
    for (let i = want.length - 1; i >= 0; i--) {
      const key = want[i];
      if (cols.includes(key)) continue;
      if (afterIdx >= 0) cols.splice(afterIdx + 1, 0, key);
      else cols.push(key);
    }
    EMAIL_COLUMNS = cols;
    EMAIL_HEADER_LABELS = {
      ...EMAIL_HEADER_LABELS,
      court: "Court",
      court_number: "Court #",
    };
  }
  // Corsage/Boutonniere: Wear Style is included in the Item text, so we do NOT add a separate column.
  if (isBanquetKind) {
    EMAIL_COLUMNS = (EMAIL_COLUMNS || []).flatMap((c) => (c === "item" ? ["item", "meal_type"] : [c]));
    EMAIL_HEADER_LABELS = { ...EMAIL_HEADER_LABELS, meal_type: "Meal Type" };
  }

  if (isPreRegBase) {
    // Ensure Pre-Registration chair spreadsheets clearly indicate Voting vs Non-Voting
    const cols = Array.isArray(EMAIL_COLUMNS) ? [...EMAIL_COLUMNS] : [];
    if (!cols.includes("voting_status")) {
      const at = cols.indexOf("attendee_title");
      const insAt = at >= 0 ? at + 1 : 0;
      cols.splice(insAt, 0, "voting_status");
      EMAIL_COLUMNS = cols;
    }
    EMAIL_HEADER_LABELS = { ...EMAIL_HEADER_LABELS, voting_status: "Voting Status" };
  }


  const sorted = sortByDateAsc(filtered, "date");
  let counter = 1;

  const numbered = sorted.map((r) => {
    const hasAttendee = String(r.attendee || "").trim().length > 0;

    const splitItemAndPrice = (val) => {
      const s = String(val || "").trim();
      // Match a trailing price like "$25" or "$25.00" (optionally preceded by dash/colon)
      const m = s.match(/^(.*?)(?:\s*[-–—:]\s*)?\$\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*$/);
      if (!m) return { item_name: s, item_price: "" };
      const name = String(m[1] || "").replace(/[-–—:\s]+$/g, "").trim();
      return { item_name: name || s, item_price: m[2] || "" };
    };

    const ip = isLoveGiftBase ? splitItemAndPrice(r.item) : null;

    const splitMealType = (val) => {
      const s = String(val || "").trim();
      const m = s.match(/^(.*)\(([^)]+)\)\s*$/);
      if (!m) return { item: s, meal_type: "" };
      const baseName = String(m[1] || "").trim();
      const inside = String(m[2] || "").trim();
      let meal = "";
      if (/chicken/i.test(inside)) meal = "Chicken";
      else if (/beef/i.test(inside)) meal = "Beef";
      else meal = inside;
      return { item: baseName || s, meal_type: meal };
    };

    const bm = isBanquetKind ? splitMealType(r.item) : null;

    const deriveVotingStatus = (row) => {
      // No defaults: only return a value if it is explicitly present in stored text.
      const blob = [row?.attendee_title, row?.item, row?.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (/non\s*-?\s*voting/.test(blob) || /nonvoting/.test(blob)) return "Non-Voting";
      if (/\bvoting\b/.test(blob)) return "Voting";
      return "";
    };

    const baseRow = {
      "#": hasAttendee ? counter++ : "",
      date: r.date,
      attendee: r.attendee,
      attendee_title: r.attendee_title,
      attendee_phone: r.attendee_phone,
    };
    
	// ✅ Court fields (needed because we add these headers for banquets + certain addons)
      if ((EMAIL_COLUMNS || []).includes("court")) {
      baseRow.court = r.court || "";
    }
      if ((EMAIL_COLUMNS || []).includes("court_number")) {
      baseRow.court_number = r.court_number || "";
    }


    if (isPreRegBase) {
      baseRow.voting_status = deriveVotingStatus(r);
    }

    const itemFields = isLoveGiftBase
      ? { item_name: ip.item_name, item_price: ip.item_price }
      : isBanquetKind
        ? { item: bm.item, meal_type: bm.meal_type }
        : { item: r.item };

    if (includeAddressForThisItem) {
      return {
        ...baseRow,
        attendee_email: r.attendee_email,
        attendee_addr1: r.attendee_addr1,
        attendee_addr2: r.attendee_addr2,
        attendee_city: r.attendee_city,
        attendee_state: r.attendee_state,
        attendee_postal: r.attendee_postal,
        attendee_country: r.attendee_country,
        ...itemFields,
        qty: r.qty,
        notes: r.notes,
      };
    }

    return { ...baseRow, ...itemFields, qty: r.qty, notes: r.notes };
  });

    // ✅ XLSX ATTACHMENT (always attach for chair reports)
  // FIX: Always generate a valid workbook. If there are no rows, Excel will still contain the header row.
  let xlsxBuf = null;
  try {
    const xlsxRaw = await objectsToXlsxBuffer(
      EMAIL_COLUMNS,
      numbered, // may be []
      EMAIL_HEADER_LABELS,
      "Report",
      { spacerRows: true, autoFit: true }
    );
    xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);
  } catch (e) {
    console.error("chair-report-xlsx-build-failed", { kind, id, label, scope }, e);
    xlsxBuf = null;
  }

  // SAFETY: ensure we always have a non-empty XLSX buffer (at minimum, headers)
  if (!xlsxBuf || xlsxBuf.length === 0) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Report");
    const headerRow = (EMAIL_COLUMNS || []).map((c) => (EMAIL_HEADER_LABELS && EMAIL_HEADER_LABELS[c]) || c);
    sheet.addRow(headerRow);
    xlsxBuf = Buffer.from(await workbook.xlsx.writeBuffer());
  }

const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const baseNameRaw = label || id || "report";
  const baseName = baseNameRaw.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  const filename = `Report_${id || "item"}_${scope || "current"}.xlsx`;

  const toListPref = await getChairEmailsForItemId(id);
  const { effective } = await getEffectiveSettings();

  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const envFallback = safeSplit(
      effective.REPORTS_BCC ||
      process.env.REPORTS_BCC ||
      ""
  );

  let toList = [];
  if (Array.isArray(toOverride) && toOverride.length) {
    toList = [...toOverride];
  } else if (toListPref.length && envFallback.length) {
    toList = [...toListPref, ...envFallback.filter((addr) => !toListPref.includes(addr))];
  } else if (toListPref.length) {
    toList = [...toListPref];
  } else {
    toList = [...envFallback];
  }

  const adminBccBase = safeSplit(
    effective.REPORTS_BCC || process.env.REPORTS_BCC || ""
  );
  const bccList = adminBccBase.filter((addr) => !toList.includes(addr));

  if (!toList.length && !bccList.length) return { ok: false, error: "no-recipient" };

  // ---------------------------------------------------------------------------
  // ✅ STAGGER REPORT EMAILS (single cron, no sleeps)
  //
  // Minimal change approach: if scheduling is enabled and a Yahoo recipient is
  // present, schedule *subsequent* report emails 1 minute apart. The first email
  // is immediate.
  //
  // Default: ON (to prevent burst delivery). Disable via: REPORTS_ALLOW_SCHEDULED_AT=0
  // ---------------------------------------------------------------------------
  const allowScheduled = String(process.env.REPORTS_ALLOW_SCHEDULED_AT || "1") === "1";
  const allRcpt = [...toList, ...bccList];
  const hasYahoo = allRcpt.some((e) => /@yahoo\.com$/i.test(String(e || "").trim()));

  if (!scheduledAtIso) {
    scheduledAtIso = nextReportScheduledAtIso({ allow: allowScheduled, hasYahoo, explicitIso: scheduledAtIso });
  }

  const prettyKind = kind === "other" ? "catalog" : kind;

  const scopeLabel =
    scope === "current-month"
      ? "current month (month-to-date)"
      : scope === "full"
        ? "full history (all orders for this item)"
        : scope === "custom"
          ? "custom date range"
          : String(scope || "");

  const coverageText = formatCoverageRange({ startMs, endMs, rows: sorted });

  const subject = `Report — ${prettyKind}: ${label || id}`;
  const emailSubject = `${(subjectPrefix || "").toString()}${subject}`;
  const tablePreview = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
      <p>Attached is the Excel report for <b>${prettyKind}</b> “${label || id}”.</p>
      <p>Rows: <b>${sorted.length}</b></p>
      <div style="font-size:12px;color:#555;margin:2px 0;">Scope: ${scopeLabel}</div>
      ${coverageText ? `<p style="font-size:12px;color:#555;margin:2px 0 0;">${coverageText}</p>` : ""}
      <div style="font-size:12px;color:#555;margin:6px 0 0;">Attachment: <b>${filename}</b></div>
    </div>`;

  const payload = {
    from: from,
    to: toList.length ? toList : bccList,
    bcc: toList.length && bccList.length ? bccList : undefined,
    subject,
    html: tablePreview,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename,
        content: xlsxBuf,
        content_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };

  // ✅ SCHEDULE SAFETY:
// These chair reports include XLSX attachments.
// Although Resend supports scheduled delivery, scheduled sends combined with
// attachments can lead to inconsistent behavior with some providers/clients.
// So we ONLY schedule when there are NO attachments.
//
// To reduce burst delivery without scheduling, set:
//   REPORTS_THROTTLE_MS=15000   (example: 15s between report emails)
if (scheduledAtIso && allowScheduled && (!payload.attachments || payload.attachments.length === 0)) {
  // Resend SDK expects `scheduledAt` (camelCase). We also set `scheduled_at`
  // for backward-compat / log readability, but `scheduledAt` is the one that matters.
  payload.scheduledAt = scheduledAtIso;
  payload.scheduled_at = scheduledAtIso;
}

  if (previewOnly) {
    return {
      ok: true,
      preview: true,
      kind,
      id,
      scope,
      to: toList,
      bcc: bccList,
      subject: emailSubject,
      filename,
      rowCount: Array.isArray(numbered) ? numbered.length : 0,
    };
  }

  const retry = await sendWithRetry(() => resend.emails.send(payload), `item-report:${kind}:${id}`);

  if (retry.ok) {
    const sendResult = retry.result;
    await recordMailLog({
      ts: Date.now(),
      from: from,
      to: [...toList, ...bccList],
      subject: emailSubject,
      resultId: sendResult?.id || null,
      kind: "item-report",
      status: "queued",
      scheduled_at: (payload.scheduledAt || (payload.scheduledAt || (payload.scheduledAt || payload.scheduled_at || null))),
      attachment: { filename, bytes: xlsxBuf.length },
    });
    return {
      ok: true,
      count: sorted.length,
      to: toList,
      bcc: bccList,
      scheduled_at: (payload.scheduledAt || (payload.scheduledAt || (payload.scheduledAt || payload.scheduled_at || null))),
    };
  }

  const err = retry.error;
  await recordMailLog({
    ts: Date.now(),
    from: from,
    to: [...toList, ...bccList],
    subject,
    resultId: null,
    kind: "item-report",
    status: "error",
    error: String(err?.message || err),
    scheduled_at: (payload.scheduledAt || (payload.scheduledAt || (payload.scheduledAt || payload.scheduled_at || null))),
  });
  return { ok: false, error: "send-failed", message: err?.message || String(err) };
}

// ---- real-time per-order chair emails for CATALOG items ----
const REALTIME_CHAIR_KEY_PREFIX = "order:catalog_chairs_sent:";

async function sendRealtimeChairEmailsForOrder(order) {
  if (!order || !Array.isArray(order.lines)) return { sent: 0 };
  const seen = new Set();
  let sent = 0;

  for (const li of order.lines) {
    const cat = String(li.category || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();
    const isCatalog = cat === "catalog" || metaType === "catalog";
    if (!isCatalog) continue;

    const id = String(li.itemId || "").trim();
    if (!id) continue;

    const key = `${cat}:${baseKey(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = li.itemName || id;

    const result = await sendItemReportEmailInternal({
      kind: cat || "catalog",
      id,
      label,
      scope: "full",
    });

    if (result.ok) sent += 1;
  }

  return { sent };
}

async function maybeSendRealtimeChairEmails(order) {
  if (!order?.id) return;
  const key = `${REALTIME_CHAIR_KEY_PREFIX}${order.id}`;
  const already = await kvGetSafe(key, null);
  if (already) return;

  try {
    await sendRealtimeChairEmailsForOrder(order);
    await kvSetSafe(key, new Date().toISOString());
  } catch (e) {
    console.error("realtime-chair-email-failed", e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Monthly / final receipts ZIP helpers (simple + safe; used by exports)
// ---------------------------------------------------------------------------

function monthIdUTC(ms) {
  const d = new Date(Number(ms || Date.now()));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}


// ✅ Week id in UTC, ISO-like (YYYY-Www). Week starts Monday (UTC).
function weekKeyUTC(ms) {
  const d = new Date(ms);
  // Convert so Monday=0..Sunday=6
  const day = (d.getUTCDay() + 6) % 7;
  // Thursday of this week decides the ISO year
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const isoYear = thursday.getUTCFullYear();

  // Week 1 is the week with Jan 4th
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(Date.UTC(isoYear, 0, 4 - jan4Day));

  const diffDays = Math.floor((thursday.getTime() - week1Mon.getTime()) / 86400000);
  const week = Math.floor(diffDays / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function weekRangeUTC(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  const end = start + 7 * 86400000;
  return { startMs: start, endMs: end };
}

// ✅ Weekly receipts ZIP idempotency key (per week + per mode)
function weeklyReceiptsZipSentKey(mode, weekKey) {
  const m = String(mode || "test").toLowerCase();
  const wk = String(weekKey || "").trim();
  return `receiptszip:weekly:${m}:${wk}`;
}

// ✅ Monthly receipts ZIP idempotency key (per month + per mode)
function monthlyReceiptsZipSentKey(mode, month) {
  const m = String(mode || "test").toLowerCase();
  const mm = String(month || "").trim();
  return `receiptszip:monthly:${m}:${mm}`;
}

async function emailWeeklyReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();
  const weekKey = weekKeyUTC(Date.now())
  const { startMs, endMs } = weekRangeUTC(Date.now());

  // ✅ LIVE/LIVE_TEST: only send once per month (even if cron runs daily)
  // TEST: allowed to send repeatedly (useful while testing)
  const enforceMonthlyOnce = wantMode === "live" || wantMode === "live_test";
  const sentKey = weeklyReceiptsZipSentKey(wantMode, weekKey);

  if (enforceMonthlyOnce) {
    const already = await kvGetSafe(sentKey, null);
    if (already) {
      return { ok: true, skipped: true, month: weekKey, mode: wantMode, reason: "already-sent" };
    }
  }

  const rows = [];
  const zip = new JSZip();

  for (const o of orders) {
    const om = String(o.mode || "test").toLowerCase();
    if (om !== wantMode) continue;
    if (o.created < startMs || o.created >= endMs) continue;

    const html = renderOrderEmailHTML(o);
    zip.file(`receipt-${wantMode}-${o.id}.html`, html);

    rows.push(...buildReceiptXlsxRows(o));
  }

  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipts"
  );
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  zip.file(`receipts-${wantMode}-${weekKey}.xlsx`, xlsxBuf);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const zipB64 = Buffer.from(zipBuf).toString("base64");

  const from = RESEND_FROM || "pa_sessions@yahoo.com";
  const subject = `Weekly Receipts ZIP — ${weekKey} (${wantMode})`;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">Attached: receipts ZIP for <b>${weekKey}</b> (${wantMode}).</div>`,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipts-${wantMode}-${weekKey}.zip`,
        content: zipB64,
        content_type: "application/zip",
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipts-zip-weekly:${wantMode}:${weekKey}`
  );

  if (retry.ok) {
    // ✅ Mark as sent (LIVE/LIVE_TEST only) so daily cron won't re-send
    if (enforceMonthlyOnce) {
      await kvSetSafe(sentKey, {
        sentAt: new Date().toISOString(),
        month: weekKey,
        mode: wantMode,
        subject,
      });
    }

    return { ok: true, month: weekKey, mode: wantMode };
  }

  return { ok: false, error: retry.error?.message || String(retry.error) };
}



async function emailMonthlyReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();
  const nowMonth = monthIdUTC(Date.now());

  // ✅ LIVE/LIVE_TEST: only send once per month (even if cron runs daily)
  // TEST: allowed to send repeatedly (useful while testing)
  const enforceMonthlyOnce = wantMode === "live" || wantMode === "live_test";
  const sentKey = monthlyReceiptsZipSentKey(wantMode, nowMonth);

  if (enforceMonthlyOnce) {
    const already = await kvGetSafe(sentKey, null);
    if (already) {
      return { ok: true, skipped: true, month: nowMonth, mode: wantMode, reason: "already-sent" };
    }
  }

  const rows = [];
  const zip = new JSZip();

  for (const o of orders) {
    const om = String(o.mode || "test").toLowerCase();
    if (om !== wantMode) continue;
    if (monthIdUTC(o.created) !== nowMonth) continue;

    const html = renderOrderEmailHTML(o);
    zip.file(`receipt-${wantMode}-${o.id}.html`, html);

    rows.push(...buildReceiptXlsxRows(o));
  }

  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipts"
  );
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  zip.file(`receipts-${wantMode}-${nowMonth}.xlsx`, xlsxBuf);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const zipB64 = Buffer.from(zipBuf).toString("base64");

  const from = RESEND_FROM || "pa_sessions@yahoo.com";
  const subject = `Monthly Receipts ZIP — ${nowMonth} (${wantMode})`;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">Attached: receipts ZIP for <b>${nowMonth}</b> (${wantMode}).</div>`,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipts-${wantMode}-${nowMonth}.zip`,
        content: zipB64,
        content_type: "application/zip",
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipts-zip-monthly:${wantMode}:${nowMonth}`
  );

  if (retry.ok) {
    // ✅ Mark as sent (LIVE/LIVE_TEST only) so daily cron won't re-send
    if (enforceMonthlyOnce) {
      await kvSetSafe(sentKey, {
        sentAt: new Date().toISOString(),
        month: nowMonth,
        mode: wantMode,
        subject,
      });
    }

    return { ok: true, month: nowMonth, mode: wantMode };
  }

  return { ok: false, error: retry.error?.message || String(retry.error) };
}

async function emailFinalReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();

  const rows = [];
  const zip = new JSZip();

  for (const o of orders) {
    const om = String(o.mode || "test").toLowerCase();
    if (om !== wantMode) continue;

    const html = renderOrderEmailHTML(o);
    zip.file(`receipt-${wantMode}-${o.id}.html`, html);
    rows.push(...buildReceiptXlsxRows(o));
  }

  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipts"
  );
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  zip.file(`receipts-${wantMode}-ALL.xlsx`, xlsxBuf);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const zipB64 = Buffer.from(zipBuf).toString("base64");

  const from = RESEND_FROM || "pa_sessions@yahoo.com";
  const subject = `FINAL Receipts ZIP — ALL (${wantMode})`;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">Attached: <b>FINAL</b> receipts ZIP (ALL) for mode (${wantMode}).</div>`,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipts-${wantMode}-FINAL.zip`,
        content: zipB64,
        content_type: "application/zip",
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipts-zip-final:${wantMode}`
  );
  return retry.ok ? { ok: true } : { ok: false, error: retry.error?.message || String(retry.error) };
}

// ---------------------------------------------------------------------------
// Purge orders by mode (with safe LIVE guard)
// ---------------------------------------------------------------------------

const ALLOW_LIVE_PURGE = String(process.env.ALLOW_LIVE_PURGE || "false") === "true";

function resolveOrderKey(order) {
  return `order:${String(order?.id || "").trim()}`;
}

/**
 * Purge orders by mode.
 * mode: "test" | "live_test" | "live"
 * options: { hard?: boolean }
 *
 * NOTE: any order with no `mode` is treated as "test".
 */
async function purgeOrdersByMode(mode, { hard = false } = {}) {
  if (!["test", "live_test", "live"].includes(mode)) {
    throw new Error(`Invalid mode for purge: ${mode}`);
  }

  if (mode === "live" && (hard || !ALLOW_LIVE_PURGE)) {
    throw new Error("Hard purge of LIVE data is disabled for safety.");
  }

  const all = await loadAllOrdersWithRetry();
  const target = all.filter((o) => String(o.mode || "test").toLowerCase() === mode);

  let count = 0;

  for (const order of target) {
    const key = resolveOrderKey(order);

    if (mode === "live" || !hard) {
      await kvHsetSafe(key, {
        deleted: true,
        deletedAt: new Date().toISOString(),
        deletedReason: `purge-${mode}`,
      });
    } else {
      await kvDelSafe(key);
    }
    count++;
  }

  return { count, mode, hard: mode === "live" ? false : hard };
}

// ------------- EXPORTS -------------
// prettier-ignore
export {
  kv,

  getStripe,
  getStripePublishableKey,
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,

  EMAIL_RECEIPTS,
  sendReceiptXlsxBackup,
  emailWeeklyReceiptsZip,
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,

  verifyOrderHash,
  assertNotLocked,
  getLockdownConfig,
  tokenFingerprint,

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
  computeStripeProcessingFeeFromLines,
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

  getCheckoutSettingsRaw,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
  purgeOrdersByMode,
};