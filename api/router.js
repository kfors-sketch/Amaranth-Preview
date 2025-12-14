// /api/router.js
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
} from "./admin/core.js";

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
// - Adds a stable requestId + structured error info for front-end display
// - Avoids leaking secrets (no env dumps, no raw objects)
// ============================================================================
function getRequestId(req) {
  // Vercel provides one of these on most requests; otherwise we generate a fallback.
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

  // Stripe errors often include these fields:
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
    // Only include a short stack hint (first line) so iPhone users can screenshot it.
    stackTop: typeof e.stack === "string" ? e.stack.split("\n")[0] : "",
  };

  // Only include stripe fields if they exist (keeps payload clean).
  if (Object.keys(stripe).length) safe.stripe = stripe;

  return safe;
}

function errResponse(res, status, code, req, err, extra = {}) {
  const requestId = getRequestId(req);
  const safe = toSafeError(err);

  // Always log the full error server-side with the request id
  console.error(`[router] ${code} requestId=${requestId}`, err);

  return REQ_ERR(res, status, code, {
    requestId,
    error: safe, // front-end can show error.message, error.stripe.code, etc.
    ...extra,
  });
}

// ============================================================================
// RAW BODY HELPERS (required for Stripe webhook signature verification)
// NOTE: we set api.bodyParser=false at bottom, so we must read/parse ourselves.
// ============================================================================
async function readRawBody(req) {
  // cache so we don't consume the stream twice
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
// Uses either:
//  - legacy static REPORT_TOKEN (for backward compatibility), OR
//  - new KV-backed admin tokens issued by handleAdminLogin()
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

  // 1) Allow legacy static REPORT_TOKEN for now
  const legacy = (process.env.REPORT_TOKEN || "").trim();
  if (legacy && token === legacy) return true;

  // 2) Check against new admin tokens stored in KV
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

// Pull order mode from Stripe session metadata (preferred), else fall back to the
// current effective channel.
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
// (we use this to pick the correct Stripe client for retrieval)
function inferStripeEnvFromCheckoutSessionId(id) {
  const s = String(id || "").trim();
  if (s.startsWith("cs_live_")) return "live";
  if (s.startsWith("cs_test_")) return "test";
  return "";
}

// ---------------- Catalog category helpers ----------------
//
// Back-compat:
//   cat=catalog -> KV key "products" (existing)
//
// New categories:
//   cat=supplies -> KV key "products:supplies"
//   cat=regalia  -> KV key "products:regalia"
// etc.
//
// Registry:
//   KV key "catalog:categories" stores [{cat,title,imgFolder,navLabel,...}, ...]
const CATALOG_CATEGORIES_KEY = "catalog:categories";

function normalizeCat(catRaw) {
  const cat = String(catRaw || "catalog").trim().toLowerCase();
  const safe = cat.replace(/[^a-z0-9_-]/g, "");
  return safe || "catalog";
}

function catalogItemsKeyForCat(catRaw) {
  const cat = normalizeCat(catRaw);
  if (!cat || cat === "catalog") return "products"; // existing
  return `products:${cat}`; // new cats
}

async function getCatalogCategoriesSafe() {
  const list = (await kvGetSafe(CATALOG_CATEGORIES_KEY, [])) || [];
  const out = Array.isArray(list) ? list.slice() : [];

  // Ensure required defaults exist even if the registry hasn't been saved in KV yet.
  // This keeps order/nav pages able to "discover" categories immediately.
  const ensure = (cat, title) => {
    const c = String(cat || "").trim().toLowerCase();
    if (!c) return;
    const has = out.some((x) => String(x?.cat || "").trim().toLowerCase() === c);
    if (!has) out.push({ cat: c, title });
  };

  ensure("catalog", "Product Catalog");
  ensure("supplies", "Supplies");
  ensure("charity", "Charity");

  // Keep "catalog" first for back-compat expectations
  out.sort((a, b) => {
    const ac = String(a?.cat || "").toLowerCase();
    const bc = String(b?.cat || "").toLowerCase();
    if (ac === "catalog" && bc !== "catalog") return -1;
    if (bc === "catalog" && ac !== "catalog") return 1;
    return String(a?.title || ac).localeCompare(String(b?.title || bc));
  });

  return out;
}

// -------------- main handler --------------
export default async function handler(req, res) {
  const requestId = getRequestId(req);

  try {
    const url = getUrl(req);
    const action = url.searchParams.get("action");
    const type = url.searchParams.get("type");

    // ---------- GET ----------
    if (req.method === "GET") {
      // Core smoketest via admin/debug.js
      if (type === "smoketest") {
        const out = await handleSmoketest();
        return REQ_OK(res, { requestId, ...out });
      }

      // Last mail log via admin/debug.js
      if (type === "lastmail") {
        const out = await handleLastMail();
        return REQ_OK(res, { requestId, ...out });
      }

      // Debug: token / Stripe / Resend / scheduler
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

      // Data health + scheduler dry run
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

      // Targeted previews
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

      // year_index (for reporting_yoy.html)
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

        // Existing main catalog products (back-compat)
        const products = (await kvGetSafe("products", [])) || [];
        addSlots(products, "catalog");

        // Include all additional catalog categories as catalog:<cat>
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

      // list all years we have indexed
      if (type === "years_index") {
        const years = await listIndexedYears();
        return REQ_OK(res, { requestId, years });
      }

      // summary for a single year
      if (type === "year_summary") {
        const yParam = url.searchParams.get("year");
        const year = Number(yParam);
        if (!Number.isFinite(year)) {
          return REQ_ERR(res, 400, "invalid-year", { requestId, year: yParam });
        }
        const summary = await getYearSummary(year);
        return REQ_OK(res, { requestId, ...summary });
      }

      // multi-year summary for graphs
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

      // ---------------- Catalog categories + items (multi-page ready) ----------------

      // Category registry (so order/nav/YoY can discover categories)
      if (type === "catalog_categories") {
        const categories = await getCatalogCategoriesSafe();
        return REQ_OK(res, { requestId, categories });
      }

      // Items for a given catalog category (cat=catalog -> existing "products")
      if (type === "catalog_items") {
        const cat = normalizeCat(url.searchParams.get("cat") || "catalog");
        const key = catalogItemsKeyForCat(cat);
        const items = (await kvGetSafe(key, [])) || [];
        return REQ_OK(res, { requestId, cat, items });
      }

      // Has any active items? (for hiding links + hiding whole page)
      if (type === "catalog_has_active") {
        const cat = normalizeCat(url.searchParams.get("cat") || "catalog");
        const key = catalogItemsKeyForCat(cat);
        const items = (await kvGetSafe(key, [])) || [];
        const hasActive = Array.isArray(items) && items.some((it) => it && it.active);
        return REQ_OK(res, { requestId, cat, hasActive });
      }

      // YoY helper (config view): return items by year (non-breaking even if configs are global)
      if (type === "catalog_items_yoy") {
        const cat = normalizeCat(url.searchParams.get("cat") || "catalog");

        let yearsParams = url.searchParams.getAll("year");
        if (!yearsParams.length) {
          const csv = url.searchParams.get("years") || "";
          if (csv) yearsParams = csv.split(",").map((s) => s.trim()).filter(Boolean);
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

      // Existing simple lists (back-compat)
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
        return REQ_OK(res, {
          requestId,
          env,
          overrides,
          effective,
          MAINTENANCE_ON: effective.MAINTENANCE_ON,
          MAINTENANCE_MESSAGE:
            effective.MAINTENANCE_MESSAGE || env.MAINTENANCE_MESSAGE,
        });
      }

      // Checkout / Stripe mode fetch for admin/settings.html
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

      // Mode-aware publishable key (preferred)
      if (type === "stripe_pubkey" || type === "stripe_pk") {
        const mode = await getEffectiveOrderChannel().catch(() => "test");
        return REQ_OK(res, {
          requestId,
          publishableKey: getStripePublishableKey(mode),
          mode,
        });
      }

      // ✅ FIX: retrieve checkout sessions in LIVE vs TEST automatically by ID prefix
      // (and fall back to the other env so admin tools still work if someone pastes
      // the “wrong” session ID vs selected mode)
      if (type === "checkout_session") {
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) return REQ_ERR(res, 400, "missing-id", { requestId });

        // Stripe session IDs include cs_test_ or cs_live_
        const inferred = inferStripeEnvFromCheckoutSessionId(id);

        // If unknown, choose primary based on current effective channel (live/live_test => live)
        let primaryEnv = inferred;
        if (!primaryEnv) {
          const eff = await getEffectiveOrderChannel().catch(() => "test");
          primaryEnv = eff === "live" || eff === "live_test" ? "live" : "test";
        }
        const fallbackEnv = primaryEnv === "live" ? "test" : "live";

        // Prefer the correct key first, but fall back to the other
        // so admin tools still work if someone pastes the “wrong” ID.
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
          env: usedEnv, // "live" or "test" (which Stripe client succeeded)
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
          rows = rows.filter((r) => String(r.item || "").toLowerCase().includes(want));
        }

        rows = sortByDateAsc(rows, "date");
        return REQ_OK(res, { requestId, rows });
      }

      if (type === "orders_csv") {
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
          rows = rows.filter((r) => String(r.item || "").toLowerCase().includes(want));
        }

        const sorted = sortByDateAsc(rows, "date");
        const headers = Object.keys(
          sorted[0] || {
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
          }
        );

        const buf = await objectsToXlsxBuffer(headers, sorted, null, "Orders");
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="orders.xlsx"`);
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

        const sorted = sortByDateAsc(roster, "date");
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

        const buf = await objectsToXlsxBuffer(headers, sorted, null, "Attendees");
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="attendee-roster.xlsx"`);
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

        const sorted = sortByDateAsc(roster, "date");
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

        const buf = await objectsToXlsxBuffer(headers, sorted, null, "Directory");
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

        const unique = sortByDateAsc(Array.from(map.values()), "date");

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

        const buf = await objectsToXlsxBuffer(headers, numbered, null, "Full Attendees");
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="full-attendees.xlsx"`);
        return res.status(200).send(buf);
      }

      if (type === "finalize_order") {
        const sid = String(url.searchParams.get("sid") || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid", { requestId });

        try {
          // save only (webhook is still source-of-truth for emails)
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");
          const order = await saveOrderFromSession({ id: sid }, { mode: orderChannel });

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

      return REQ_ERR(res, 400, "unknown-type", { requestId });
    }

    // ---------- POST ----------
    if (req.method === "POST") {
      // With bodyParser disabled, we MUST parse bodies ourselves.
      // For Stripe webhook we keep it RAW for signature verification.
      let body = {};
      try {
        if (action !== "stripe_webhook") {
          body = await readJsonBody(req);
        }
      } catch (e) {
        return errResponse(res, 400, "invalid-json", req, e);
      }

      // --- High-security admin login ---
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

      // --- Quick manual Resend test (no auth) ---
      if (action === "test_resend") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured", { requestId });
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

        const retry = await sendWithRetry(() => resend.emails.send(payload), "manual-test");

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
          return REQ_OK(res, { requestId, ok: true, id: sendResult?.id || null, to });
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

      // --- Contact form (no auth) ---
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
          topicMap[String(topic).toLowerCase()] || String(topic) || "General question";
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
                  <td style="padding:6px 8px;border:1px solid #ddd;white-space:pre-wrap;">${esc(msg)}</td>
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
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured", { requestId });

        const subject = `Website contact — ${topicLabel}`;

        const payload = {
          from: RESEND_FROM || "onboarding@resend.dev",
          to: toList.length ? toList : bccList,
          bcc: toList.length && bccList.length ? bccList : undefined,
          subject,
          html,
          reply_to: senderEmail || REPLY_TO || undefined,
        };

        const retry = await sendWithRetry(() => resend.emails.send(payload), "contact-form");

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

      // --- Finalize (save only) from success page ---
      // IMPORTANT: emails are sent from the Stripe webhook, not here.
      if (action === "finalize_checkout") {
        try {
          const stripe = await getStripe();
          if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured", { requestId });
          const sid = String(body.sid || body.id || "").trim();
          if (!sid) return REQ_ERR(res, 400, "missing-sid", { requestId });

          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");
          const order = await saveOrderFromSession({ id: sid }, { mode: orderChannel });

          return REQ_OK(res, { requestId, ok: true, orderId: order.id });
        } catch (e) {
          return errResponse(res, 500, "finalize-checkout-failed", req, e);
        }
      }

      // ---- PUBLIC: send chair-specific XLSX by category+item (no auth) ----
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

      // ---- CREATE CHECKOUT (bundle protection + international fee) ----
      if (action === "create_checkout_session") {
        try {
          // ✅ Determine effective channel FIRST, then initialize Stripe with that mode.
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");

          const stripe = await getStripe(orderChannel);
          if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          const origin = req.headers.origin || `https://${req.headers.host}`;
          const successUrl =
            (body.success_url || `${origin}/success.html`) + `?sid={CHECKOUT_SESSION_ID}`;
          const cancelUrl = body.cancel_url || `${origin}/order.html`;

          if (Array.isArray(body.lines) && body.lines.length) {
            const lines = body.lines;
            const fees = body.fees || { pct: 0, flat: 0 };
            const purchaser = body.purchaser || {};

            const line_items = lines.map((l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle = priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;

              const unit_amount = isBundle
                ? cents(l.bundleTotalCents)
                : toCentsAuto(l.unitPrice || 0);
              const quantity = isBundle ? 1 : Math.max(1, Number(l.qty || 1));

              return {
                quantity,
                price_data: {
                  currency: "usd",
                  unit_amount,
                  product_data: {
                    name: String(l.itemName || "Item"),
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
                      itemNote: l.meta?.itemNote || "",
                      attendeeAddr1: l.meta?.attendeeAddr1 || "",
                      attendeeAddr2: l.meta?.attendeeAddr2 || "",
                      attendeeCity: l.meta?.attendeeCity || "",
                      attendeeState: l.meta?.attendeeState || "",
                      attendeePostal: l.meta?.attendeePostal || "",
                      attendeeCountry: l.meta?.attendeeCountry || "",
                      priceMode: priceMode || "",
                      bundleQty: isBundle ? String(l.bundleQty || "") : "",
                      bundleTotalCents: isBundle ? String(unit_amount) : "",
                    },
                  },
                },
              };
            });

            const pct = Number(fees.pct || 0);
            const flatCents = toCentsAuto(fees.flat || 0);

            const subtotalCents = lines.reduce((s, l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle = priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;
              if (isBundle) return s + cents(l.bundleTotalCents || 0);
              return s + toCentsAuto(l.unitPrice || 0) * Number(l.qty || 0);
            }, 0);

            const feeAmount = Math.max(0, Math.round(subtotalCents * (pct / 100)) + flatCents);
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

            // International card processing fee (3%)
            const purchaserCountry = String(purchaser.country || purchaser.addressCountry || "US")
              .trim()
              .toUpperCase();
            const accountCountry = String(process.env.STRIPE_ACCOUNT_COUNTRY || "US")
              .trim()
              .toUpperCase();

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
                purchaser_country: purchaser.country || "",
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
          // the front-end will now receive a clear stripe error reason instead of just "router failed".
          return errResponse(res, 500, "checkout-create-failed", req, e, {
            hint:
              "If this only fails in live-test/live, it usually means STRIPE_SECRET_KEY_LIVE or webhook secret is missing/mismatched in that environment.",
          });
        }
      }

      // ✅ FIX: action=stripe_webhook verify signature against LIVE + TEST + fallback secrets
      if (action === "stripe_webhook") {
        try {
          const sig = req.headers["stripe-signature"];
          if (!sig) return REQ_ERR(res, 400, "missing-signature", { requestId });

          const whsecLive = (process.env.STRIPE_WEBHOOK_SECRET_LIVE || "").trim();
          const whsecTest = (process.env.STRIPE_WEBHOOK_SECRET_TEST || "").trim();
          const whsecFallback = (process.env.STRIPE_WEBHOOK_SECRET || "").trim(); // backward compat

          const trySecrets = [whsecLive, whsecTest, whsecFallback].filter(Boolean);
          if (!trySecrets.length) {
            console.error("[webhook] no webhook secrets configured");
            return REQ_ERR(res, 500, "missing-webhook-secret", { requestId });
          }

          // IMPORTANT: Stripe signs the RAW bytes, not parsed JSON.
          const raw = await readRawBody(req);

          // Use either Stripe client; constructEvent does not depend on API keys, but
          // we keep your existing pattern.
          const stripeAny =
            (await getStripe("live")) || (await getStripe("test")) || (await getStripe());
          if (!stripeAny) return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          let event = null;
          let verifiedWith = "";

          for (const secret of trySecrets) {
            try {
              event = stripeAny.webhooks.constructEvent(raw, sig, secret);
              verifiedWith =
                secret === whsecLive ? "live" : secret === whsecTest ? "test" : "fallback";
              break;
            } catch {}
          }

          if (!event) {
            console.error("Webhook signature verification failed with all known secrets");
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
              // -----------------------------------------------------------------
              // FIX: DO NOT detach async email sending in serverless.
              // We await receipts + realtime chair emails so Vercel won't end the
              // function before emails finish.
              // -----------------------------------------------------------------
              const session = event.data.object;
              const mode = await resolveModeFromSession(session);

              console.log("[webhook] checkout.session.completed", {
                requestId,
                sessionId: session?.id || null,
                mode,
                verifiedWith,
                livemode: !!event.livemode,
              });

              const order = await saveOrderFromSession(session.id || session, { mode });

              try {
                console.log("[webhook] sending receipts...", {
                  requestId,
                  orderId: order?.id || null,
                });
                await sendOrderReceipts(order);

                console.log("[webhook] sending realtime chair emails...", {
                  requestId,
                  orderId: order?.id || null,
                });
                await maybeSendRealtimeChairEmails(order);

                console.log("[webhook] emails done", {
                  requestId,
                  orderId: order?.id || null,
                });
              } catch (err) {
                console.error(
                  "[webhook] email-failed",
                  { requestId, message: err?.message || String(err) },
                  err
                );
              }

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

      // ---------- register_item (used by admin chairs sync) ----------
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

        if (!id || !name) return REQ_ERR(res, 400, "id-and-name-required", { requestId });

        const emails = Array.isArray(chairEmails)
          ? chairEmails
          : String(chairEmails || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);

        const existing = await kvHgetallSafe(`itemcfg:${id}`);

        const freq = normalizeReportFrequency(
          reportFrequency || existing?.reportFrequency || existing?.report_frequency || "monthly"
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

      // --- SAFE ADMIN-ONLY PURGE OF ORDERS BY MODE ---
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

        const wrappedSendItemReport = async (opts) => {
          const kind = String(opts?.kind || "").toLowerCase();
          let offsetMinutes = 0;

          if (kind === "addon") offsetMinutes = 5;
          else if (kind === "catalog") offsetMinutes = 10;

          let scheduledAt;
          if (offsetMinutes > 0) {
            const ts = baseNow.getTime() + offsetMinutes * 60 * 1000;
            scheduledAt = new Date(ts).toISOString();
          }

          return sendItemReportEmailInternal({ ...opts, scheduledAt });
        };

        const { sent, skipped, errors, itemsLog } = await runScheduledChairReports({
          now: baseNow,
          sendItemReportEmailInternal: wrappedSendItemReport,
        });

        // Monthly log email to admins (REPORTS_LOG_TO)
        try {
          const logRecipients = REPORTS_LOG_TO.split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          if (resend && logRecipients.length) {
            const ts = new Date();
            const dateStr = ts.toISOString().slice(0, 10);
            const timeStr = ts.toISOString();

            const firstOfMonth = new Date(
              Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), 1, 0, 0, 0, 0)
            );
            const firstIso = firstOfMonth.toISOString();

            const esc = (s) => String(s || "").replace(/</g, "&lt;");

            const rowsHtml = (itemsLog || []).length
              ? itemsLog
                  .map((it, idx) => {
                    const status = it.skipped ? "SKIPPED" : it.ok ? "OK" : "ERROR";
                    const rowsLabel = it.skipped ? "-" : it.count;
                    const errorText = it.skipped ? it.skipReason || "" : it.error || "";

                    return `
              <tr>
                <td style="padding:4px;border:1px solid #ddd;">${idx + 1}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.id)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.label)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.kind)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(status)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${rowsLabel}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(
                  (it.to || []).join(", ")
                )}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(
                  (it.bcc || []).join(", ")
                )}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(errorText)}</td>
              </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="9" style="padding:6px;border:1px solid #ddd;">No items processed.</td></tr>`;

            const html = `
              <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
                <h2 style="margin-bottom:4px;">Scheduled Chair Reports Log</h2>
                <p style="margin:2px 0;">Run time (UTC): <b>${esc(timeStr)}</b></p>
                <p style="margin:2px 0;">Scope: <b>current-month</b></p>
                <p style="margin:2px 0;"><strong>Coverage (UTC): from ${esc(
                  firstIso
                )} through ${esc(timeStr)}.</strong></p>
                <p style="margin:2px 0;font-size:12px;color:#555;">requestId: ${esc(
                  requestId
                )}</p>
                <p style="margin:6px 0 10px;">
                  Sent: <b>${sent}</b> &nbsp; | &nbsp;
                  Skipped: <b>${skipped}</b> &nbsp; | &nbsp;
                  Errors: <b>${errors}</b>
                </p>
                <table style="border-collapse:collapse;border:1px solid #ccc;font-size:13px;">
                  <thead>
                    <tr>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">#</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">ID</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Label</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Kind</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Status</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Rows</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">To</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">BCC</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Error / Reason</th>
                    </tr>
                  </thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
              </div>
            `;

            const subject = `Scheduled chair report log — ${dateStr}`;

            const payload = {
              from: RESEND_FROM || "onboarding@resend.dev",
              to: logRecipients,
              subject,
              html,
              reply_to: REPLY_TO || undefined,
            };

            const retry = await sendWithRetry(() => resend.emails.send(payload), "monthly-log");
            if (retry.ok) {
              const sendResult = retry.result;
              await recordMailLog({
                ts: Date.now(),
                from: payload.from,
                to: logRecipients,
                subject,
                resultId: sendResult?.id || null,
                kind: "monthly-log",
                status: "queued",
              });
            } else {
              const err = retry.error;
              await recordMailLog({
                ts: Date.now(),
                from: payload.from,
                to: logRecipients,
                subject,
                resultId: null,
                kind: "monthly-log",
                status: "error",
                error: String(err?.message || err),
              });
            }
          }
        } catch (e) {
          console.error("monthly_log_email_failed", e?.message || e);
        }

        return REQ_OK(res, {
          requestId,
          ok: true,
          sent,
          skipped,
          errors,
          scope: "current-month",
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

        return REQ_OK(res, { requestId, ok: true, sent, skipped, errors, scope: "full" });
      }

      if (action === "clear_orders") {
        await kvDelSafe("orders:index");
        return REQ_OK(res, { requestId, ok: true, message: "orders index cleared" });
      }

      if (action === "create_refund") {
        try {
          const stripe = await getStripe();
          if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured", { requestId });
          const payment_intent = String(body.payment_intent || "").trim();
          const charge = String(body.charge || "").trim();
          const amount_cents_raw = body.amount_cents;
          const args = {};
          if (amount_cents_raw != null) args.amount = cents(amount_cents_raw);
          if (payment_intent) args.payment_intent = payment_intent;
          else if (charge) args.charge = charge;
          else return REQ_ERR(res, 400, "missing-payment_intent-or-charge", { requestId });

          const rf = await stripe.refunds.create(args);
          try {
            await applyRefundToOrder(rf.charge, rf);
          } catch {}
          return REQ_OK(res, { requestId, ok: true, id: rf.id, status: rf.status });
        } catch (e) {
          return errResponse(res, 500, "refund-failed", req, e);
        }
      }

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets) ? body.banquets : [];
        await kvSetSafe("banquets", list);

        try {
          for (const b of list) {
            const id = String(b?.id || "");
            if (!id) continue;
            const name = String(b?.name || "");
            const chairEmails = Array.isArray(b?.chairEmails)
              ? b.chairEmails
              : String(b?.chairEmails || b?.chair?.email || "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);

            const freq = normalizeReportFrequency(
              b?.reportFrequency || b?.report_frequency || "monthly"
            );

            const cfg = {
              id,
              name,
              kind: "banquet",
              chairEmails,
              publishStart: b?.publishStart || "",
              publishEnd: b?.publishEnd || "",
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
            const id = String(a?.id || "");
            if (!id) continue;
            const name = String(a?.name || "");
            const chairEmails = Array.isArray(a?.chairEmails)
              ? a.chairEmails
              : String(a?.chairEmails || a?.chair?.email || "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);

            const freq = normalizeReportFrequency(
              a?.reportFrequency || a?.report_frequency || "monthly"
            );

            const cfg = {
              id,
              name,
              kind: "addon",
              chairEmails,
              publishStart: a?.publishStart || "",
              publishEnd: a?.publishEnd || "",
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };
            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      // Existing products save (back-compat for main catalog)
      if (action === "save_products") {
        const list = Array.isArray(body.products) ? body.products : [];
        await kvSetSafe("products", list);

        try {
          for (const p of list) {
            const id = String(p?.id || "");
            if (!id) continue;
            const name = String(p?.name || "");
            const chairEmails = Array.isArray(p?.chairEmails)
              ? p.chairEmails
              : String(p?.chairEmails || p?.chair?.email || "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);

            const freq = normalizeReportFrequency(
              p?.reportFrequency || p?.report_frequency || "monthly"
            );

            const cfg = {
              id,
              name,
              kind: "catalog",
              chairEmails,
              publishStart: p?.publishStart || "",
              publishEnd: p?.publishEnd || "",
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };
            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      // NEW: Save items for any catalog-like category
      // POST /api/router?action=save_catalog_items&cat=supplies
      if (action === "save_catalog_items") {
        const cat = normalizeCat(url.searchParams.get("cat") || body?.cat || "catalog");
        const key = catalogItemsKeyForCat(cat);

        const list = Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.products)
          ? body.products
          : [];
        await kvSetSafe(key, list);

        // Keep itemcfg in sync (same pattern as save_products)
        try {
          for (const p of list) {
            const id = String(p?.id || "");
            if (!id) continue;
            const name = String(p?.name || "");
            const chairEmails = Array.isArray(p?.chairEmails)
              ? p.chairEmails
              : String(p?.chairEmails || p?.chair?.email || "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);

            const freq = normalizeReportFrequency(
              p?.reportFrequency || p?.report_frequency || "monthly"
            );

            const cfg = {
              id,
              name,
              kind: cat === "catalog" ? "catalog" : `catalog:${cat}`,
              chairEmails,
              publishStart: p?.publishStart || "",
              publishEnd: p?.publishEnd || "",
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

        if ("MAINTENANCE_ON" in allow) allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);

        if ("REPORT_FREQUENCY" in allow) {
          allow.REPORT_FREQUENCY = normalizeReportFrequency(allow.REPORT_FREQUENCY);
        }

        // Clamp weekday to 1–7 and store as string
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

      // Save checkout / Stripe mode + date window (admin/settings.html)
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
    // FINAL CATCH: returns structured info (requestId + safe error details)
    return errResponse(res, 500, "router-failed", req, e);
  }
}

// Vercel Node 22 runtime
// IMPORTANT: bodyParser must be disabled so Stripe webhook signature verification works.
export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};
