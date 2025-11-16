// /api/router.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";
import ExcelJS from "exceljs";

// ---- Lazy Stripe loader (avoid crashing function at import time) ----
let _stripe = null;
async function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return null;
  const { default: Stripe } = await import("stripe");
  _stripe = new Stripe(key);
  return _stripe;
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ---- Mail “From / Reply-To” (sanitized) ----
const RESEND_FROM = (process.env.RESEND_FROM || "").trim();
const REPLY_TO = (process.env.REPLY_TO || process.env.REPORTS_REPLY_TO || "").trim();

const REQ_OK  = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });

// ---------- helpers ----------
function cents(n) { return Math.round(Number(n || 0)); }
function dollarsToCents(n) { return Math.round(Number(n || 0) * 100); }
function toCentsAuto(v) {
  const n = Number(v || 0);
  return n < 1000 ? Math.round(n * 100) : Math.round(n);
}

async function kvGetSafe(key, fallback = null) { try { return await kv.get(key); } catch { return fallback; } }
async function kvHsetSafe(key, obj)          { try { await kv.hset(key, obj); return true; } catch { return false; } }
async function kvSaddSafe(key, val)          { try { await kv.sadd(key, val); return true; } catch { return false; } }
async function kvSetSafe(key, val)           { try { await kv.set(key, val);  return true; } catch { return false; } }
async function kvHgetallSafe(key)            { try { return (await kv.hgetall(key)) || {}; } catch { return {}; } }
async function kvSmembersSafe(key)           { try { return await kv.smembers(key); } catch { return []; } }
async function kvDelSafe(key)                { try { await kv.del(key); return true; } catch { return false; } }

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
// Sort small helper (ASC: old -> new)
function sortByDateAsc(arr, key = "date") {
  return (arr || []).slice().sort((a, b) => {
    const ta = parseDateISO(a?.[key]);
    const tb = parseDateISO(b?.[key]);
    return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
  });
}

// Base id helper: everything before the first colon (handles adult/child/custom etc.)
const baseKey = (s) => String(s || "").toLowerCase().split(":")[0];

// Legacy normalizer kept (but baseKey is what we actually rely on now)
const normalizeKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/:(adult|child|youth)$/i, "");

// Build effective settings (env + overrides)
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
    // Optional reporting window
    EVENT_START: process.env.EVENT_START || "", // e.g. "2025-11-01"
    EVENT_END: process.env.EVENT_END || "",     // e.g. "2025-11-10"
    REPORT_ORDER_DAYS: process.env.REPORT_ORDER_DAYS || "" // e.g. "30"
  };
  const effective = {
    ...env,
    ...overrides,
    MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true",
  };
  return { env, overrides, effective };
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
        raw === wantRaw || // exact
        rawNorm === wantNorm || // legacy normalized (“:adult” etc.)
        keyBase === wantBase || // base id from raw
        rowBase === wantBase || // precomputed base on the row
        String(r._itemKey || "").toLowerCase() === wantNorm // legacy hidden key
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
async function recordMailLog(payload) {
  try {
    await kv.set(MAIL_LOG_KEY, payload, { ex: 3600 });
  } catch {}
}

// Simple bearer auth for admin writes
function requireToken(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== (process.env.REPORT_TOKEN || "")) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }
  return true;
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

// ----- Chair email resolution (NEW) -----
async function getChairEmailsForItemId(id) {
  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  // Prefer Banquets KV
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

  // Then Addons KV (if you also store chair emails here)
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

  // Finally, legacy / mirrored configs (banquets/addons/products)
  const cfg = await kvHgetallSafe(`itemcfg:${id}`);
  const legacyArr = Array.isArray(cfg?.chairEmails)
    ? cfg.chairEmails
    : safeSplit(cfg?.chairEmails || "");
  return legacyArr;
}

// ----- order persistence helpers -----
// (PATCH) prefer purchaser fields from metadata (your Order page), fall back to Stripe customer_details
async function saveOrderFromSession(sessionLike) {
  const stripe = await getStripe();
  if (!stripe) throw new Error("stripe-not-configured");

  const sid = typeof sessionLike === "string" ? sessionLike : sessionLike.id;
  const { session: s, lineItems } = await fetchSessionAndItems(stripe, sid);

  const lines = lineItems.map((li) => {
    const name = li.description || li.price?.product?.name || "Item";
    const qty = Number(li.quantity || 1);
    const unit = cents(li.price?.unit_amount || 0); // Stripe returns cents
    const total = unit * qty;
    const meta = li.price?.product?.metadata || {};
    return {
      id: `${sid}:${li.id}`,
      itemName: name,
      qty,
      unitPrice: unit,
      gross: total,
      category: (meta.itemType || "").toLowerCase() || "other",
      attendeeId: meta.attendeeId || "",
      itemId: meta.itemId || "", // <-- important
      meta: {
        // attendee identity & notes
        attendeeName: meta.attendeeName || "",
        attendeeTitle: meta.attendeeTitle || "",
        attendeePhone: meta.attendeePhone || "",
        attendeeEmail: meta.attendeeEmail || "",
        attendeeNotes: meta.attendeeNotes || "",
        dietaryNote: meta.dietaryNote || "",
        itemNote: meta.itemNote || "",
        // (directory / pre-reg)
        attendeeAddr1: meta.attendeeAddr1 || "",
        attendeeAddr2: meta.attendeeAddr2 || "",
        attendeeCity: meta.attendeeCity || "",
        attendeeState: meta.attendeeState || "",
        attendeePostal: meta.attendeePostal || "",
        attendeeCountry: meta.attendeeCountry || "",
        // pricing metadata
        priceMode: meta.priceMode || "",
        bundleQty: meta.bundleQty || "",
        bundleTotalCents: meta.bundleTotalCents || "",
        // item type hint (catalog / banquet / addon)
        itemType: meta.itemType || "",
      },
      notes: "",
    };
  });

  // (NEW) purchaser from metadata
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

  const order = {
    id: sid,
    created: Date.now(),
    payment_intent:
      typeof s.payment_intent === "string"
        ? s.payment_intent
        : s.payment_intent?.id || "",
    charge: null,
    currency: s.currency || "usd",
    amount_total: cents(s.amount_total || 0),

    // keep Stripe's email as receipt email if present; ot
