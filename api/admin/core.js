// /api/admin/core.js
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
const REPORTS_LOG_TO = (process.env.REPORTS_LOG_TO || "").trim(); // log recipients for monthly cron summary
const CONTACT_TO = (process.env.CONTACT_TO || "pa_sessions@yahoo.com").trim(); // contact form receiver

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

// Small sleep helper for retries
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Email retry helper (3 attempts, spacing 2s → 5s → 10s) ----
async function sendWithRetry(sendFn, label = "email") {
  const attempts = [0, 2000, 5000, 10000];
  let lastErr = null;

  for (let i = 1; i <= 3; i++) {
    try {
      if (attempts[i] > 0) {
        await sleep(attempts[i]);
      }
      const result = await sendFn();
      return { ok: true, attempt: i, result };
    } catch (err) {
      lastErr = err;
      console.error(`Retry ${i} failed for ${label}:`, err);
    }
  }
  return { ok: false, error: lastErr };
}

// Cached orders for the lifetime of a single lambda invocation
let _ordersCache = null;
let _ordersCacheLoadedAt = 0;

// Load all orders with a few retries to be safer on cold starts
async function loadAllOrdersWithRetry(options = {}) {
  const { retries = 4, delayMs = 500 } = options;

  if (Array.isArray(_ordersCache)) {
    return _ordersCache;
  }

  let lastOrders = [];

  for (let attempt = 0; attempt < retries; attempt++) {
    const idx = await kvSmembersSafe("orders:index");
    const orders = [];
    for (const sid of idx) {
      const o = await kvGetSafe(`order:${sid}`, null);
      if (o) orders.push(o);
    }
    lastOrders = orders;

    // If there are any orders, or if there truly are no orders at all, stop retrying.
    if (orders.length > 0 || idx.length === 0) {
      _ordersCache = orders;
      _ordersCacheLoadedAt = Date.now();
      return orders;
    }

    if (attempt < retries - 1) {
      await sleep(delayMs);
    }
  }

  _ordersCache = lastOrders;
  _ordersCacheLoadedAt = Date.now();
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
        attendeeName: meta.attendeeName || "",
        attendeeTitle: meta.attendeeTitle || "",
        attendeePhone: meta.attendeePhone || "",
        attendeeEmail: meta.attendeeEmail || "",
        attendeeNotes: meta.attendeeNotes || "",
        dietaryNote: meta.dietaryNote || "",
        itemNote: meta.itemNote || "",
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

  const piId = order.payment_intent;
  if (piId) {
    const pi = await stripe.paymentIntents
      .retrieve(piId, { expand: ["charges.data"] })
      .catch(() => null);
    if (pi?.charges?.data?.length) order.charge = pi.charges.data[0].id;
  }

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
      o.status =
        o.refunded_cents >= o.amount_total ? "refunded" : "partial_refund";
      await kvSetSafe(key, o);
      return true;
    }
  }
  return false;
}

// --- Flatten an order into report rows (CSV-like) ---
function flattenOrderToRows(o) {
  const rows = [];
  (o.lines || []).forEach((li) => {
    const net = li.gross;
    const rawId = li.itemId || "";
    const base = baseKey(rawId);

    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: li.meta?.attendeeName || "",
      category: li.category || "other",
      item: li.itemName || "",
      item_id: rawId,
      qty: li.qty || 1,
      price: (li.unitPrice || 0) / 100,
      gross: (li.gross || 0) / 100,
      fees: 0,
      net: (net || 0) / 100,
      status: o.status || "paid",
      notes:
        li.category === "banquet"
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote]
              .filter(Boolean)
              .join("; ")
          : li.meta?.itemNote || "",
      _itemId: rawId,
      _itemBase: base,
      _itemKey: normalizeKey(rawId),
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id,
    });
  });

  const feeLine = (o.lines || []).find((li) =>
    /processing fee/i.test(li.itemName || "")
  );
  if (feeLine) {
    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "",
      category: "other",
      item: feeLine.itemName || "Processing Fee",
      item_id: "",
      qty: feeLine.qty || 1,
      price: (feeLine.unitPrice || 0) / 100,
      gross: (feeLine.gross || 0) / 100,
      fees: 0,
      net: (feeLine.gross || 0) / 100,
      status: o.status || "paid",
      notes: "",
      _itemId: "",
      _itemBase: "",
      _itemKey: "",
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id,
    });
  }
  return rows;
}

// -------- Email rendering + sending (receipts) --------
function absoluteUrl(path = "/") {
  const base = (process.env.SITE_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

function renderOrderEmailHTML(order) {
  // cents → money
  const money = (c) =>
    (Number(c || 0) / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });

  const logoUrl = absoluteUrl("/assets/img/receipt_logo.svg");
  const purchaserName = order?.purchaser?.name || "Purchaser";
  const lines = order.lines || [];

  const topCatalog = [];
  const attendeeGroups = {};

  // NEW: split Stripe fee vs international fee
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

    const isIntlFee =
      itemId === "intl-fee" ||
      /international card processing fee/i.test(name);

    // Skip fee lines from the item tables and track them for the summary
    if (isProcessingFee) {
      processingFeeCents += lineCents;
      return;
    }
    if (isIntlFee) {
      intlFeeCents += lineCents;
      return;
    }

    const isBanquet = cat === "banquet" || /banquet/i.test(name);
    const isAddon =
      cat === "addon" ||
      /addon/i.test(li.meta?.itemType || "") ||
      /addon/i.test(name);

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
        const isBanquet =
          cat === "banquet" || /banquet/i.test(li.itemName || "");
        const notes = isBanquet
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote]
              .filter(Boolean)
              .join("; ")
          : li.meta?.itemNote || "";
        const notesRow = notes
          ? `<div style="font-size:12px;color:#444;margin-top:2px">Notes: ${String(
              notes
            ).replace(/</g, "&lt;")}</div>`
          : "";
        const lineTotal =
          Number(li.unitPrice || 0) * Number(li.qty || 1);
        return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee">
            ${li.itemName || ""}${notesRow}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${
            Number(li.qty || 1)
          }</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(
            li.unitPrice || 0
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(
            lineTotal
          )}</td>
        </tr>`;
      })
      .join("");

    const subtotal = rows.reduce(
      (s, li) =>
        s + Number(li.unitPrice || 0) * Number(li.qty || 1),
      0
    );

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

  // --- New summary breakdown to match the order page ---
  // Re-scan all lines to compute subtotal vs shipping (fee lines already tracked above)
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
      const isIntlFee =
        itemId === "intl-fee" ||
        /international card processing fee/i.test(name);
      const isShipping =
        cat === "shipping" ||
        metaType === "shipping" ||
        itemId === "shipping";

      if (isProcessingFee || isIntlFee) {
        continue; // handled separately
      }

      if (isShipping) {
        shipping += lineCents;
        continue;
      }

      // Everything else counts as "items subtotal"
      itemsSubtotal += lineCents;
    }

    return { itemsSubtotalCents: itemsSubtotal, shippingCents: shipping };
  })();

  const grandTotalCents =
    itemsSubtotalCents +
    shippingCents +
    processingFeeCents +
    intlFeeCents;

  // Fallback to Stripe's amount_total if for some reason the computed total is 0
  const totalCents =
    grandTotalCents > 0
      ? grandTotalCents
      : Number(order.amount_total || 0);

  // Build summary footer rows
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
        <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(
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
      <img src="${logoUrl}" alt="Logo" style="height:28px;max-width:160px;object-fit:contain" />
      <div>
        <div style="font-size:18px;font-weight:800">Grand Court of PA — Order of the Amaranth</div>
        <div style="font-size:14px;color:#555">Order #${order.id}</div>
      </div>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-top:8px">
      <div style="font-weight:700;margin-bottom:8px">Purchaser</div>
      <div>${purchaserName}</div>
      <div>${order.customer_email || ""}</div>
      <div>${order.purchaser?.phone || ""}</div>
    </div>

    <h2 style="margin:16px 0 8px">Order Summary</h2>
    ${topCatalogHtml}
    ${attendeeHtml || "<p>No items.</p>"}

    <table style="width:100%;border-collapse:collapse;margin-top:12px">
      <tfoot>
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">Subtotal</td>
          <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(
            itemsSubtotalCents
          )}</td>
        </tr>
        ${shippingRow}
        ${processingRow}
        ${intlRow}
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">Total</td>
          <td style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">${money(
            totalCents
          )}</td>
        </tr>
      </tfoot>
    </table>

    <p style="color:#666;font-size:12px;margin-top:12px">Thank you for your order!</p>
  </div>
  </body></html>`;
}

async function sendOrderReceipts(order) {
  if (!resend) return { sent: false, reason: "resend-not-configured" };

  const html = renderOrderEmailHTML(order);
  const subject = `Grand Court of PA - order #${order.id}`;

  const purchaserEmail = (order.customer_email || "").trim();
  const adminList = (
    process.env.REPORTS_BCC || process.env.REPORTS_CC || ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Purchaser receipt (with retry)
  if (purchaserEmail) {
    const payload = {
      from: RESEND_FROM,
      to: [purchaserEmail],
      subject,
      html,
      reply_to: REPLY_TO || undefined,
    };

    const retry = await sendWithRetry(
      () => resend.emails.send(payload),
      `receipt:purchaser:${order.id}`
    );

    if (retry.ok) {
      const sendResult = retry.result;
      await recordMailLog({
        ts: Date.now(),
        from: RESEND_FROM,
        to: [purchaserEmail],
        subject,
        orderId: order?.id || "",
        resultId: sendResult?.id || null,
        status: "queued",
        kind: "receipt-purchaser",
      });
    } else {
      const err = retry.error;
      await recordMailLog({
        ts: Date.now(),
        from: RESEND_FROM,
        to: [purchaserEmail],
        subject,
        orderId: order?.id || "",
        resultId: null,
        status: "error",
        kind: "receipt-purchaser",
        error: String(err?.message || err),
      });
    }
  }

  // Admin copy (with retry)
  if (adminList.length) {
    const payloadAdmin = {
      from: RESEND_FROM,
      to: adminList,
      subject: `${subject} (admin copy)`,
      html,
      reply_to: REPLY_TO || undefined,
    };

    const retryAdmin = await sendWithRetry(
      () => resend.emails.send(payloadAdmin),
      `receipt:admin:${order.id}`
    );

    if (retryAdmin.ok) {
      const sendResult = retryAdmin.result;
      await recordMailLog({
        ts: Date.now(),
        from: RESEND_FROM,
        to: adminList,
        subject: `${subject} (admin copy)`,
        orderId: order?.id || "",
        resultId: sendResult?.id || null,
        status: "queued",
        kind: "receipt-admin",
      });
    } else {
      const err = retryAdmin.error;
      await recordMailLog({
        ts: Date.now(),
        from: RESEND_FROM,
        to: adminList,
        subject: `${subject} (admin copy)`,
        orderId: order?.id || "",
        resultId: null,
        status: "error",
        kind: "receipt-admin",
        error: String(err?.message || err),
      });
    }
  }

  if (!purchaserEmail && !adminList.length)
    return { sent: false, reason: "no-recipients" };
  return { sent: true };
}

// --------- Helpers to build CSV for exports/emails ----------
function buildCSV(rows) {
  if (!Array.isArray(rows) || !rows.length) return "\uFEFF";
  const headers = Object.keys(
    rows[0] || {
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
    }
  );
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const sorted = sortByDateAsc(rows, "date");

  const linesOut = [headers.join(",")];
  for (const r of sorted) {
    linesOut.push(headers.map((h) => esc(r[h])).join(","));
    linesOut.push("");
  }
  return "\uFEFF" + linesOut.join("\n");
}

function buildCSVSelected(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sorted = sortByDateAsc(rows, "date");

  const lines = [headers.join(",")];
  for (const r of sorted) {
    lines.push(headers.map((h) => esc(r[h])).join(","));
    lines.push("");
  }
  return "\uFEFF" + lines.join("\n");
}

// ---- generic XLSX helper ----
async function objectsToXlsxBuffer(
  headers,
  rows,
  headerLabels = null,
  sheetName = "Report"
) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName || "Report");

  const effectiveHeaders = Array.isArray(headers) ? headers.slice() : [];

  if (effectiveHeaders.length) {
    const headerRowValues = effectiveHeaders.map(
      (h) =>
        headerLabels && headerLabels[h] !== undefined
          ? headerLabels[h]
          : h
    );
    worksheet.addRow(headerRowValues);

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  for (const r of rows || []) {
    const rowValues = effectiveHeaders.map((h) => r[h] ?? "");
    worksheet.addRow(rowValues);
  }

  worksheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    });
    col.width = max + 2;
  });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function collectAttendeesFromOrders(
  orders,
  { includeAddress = false, categories = ["banquet", "addon"], startMs, endMs } = {}
) {
  const cats = new Set(
    (categories || []).map((c) => String(c || "").toLowerCase())
  );
  const out = [];
  for (const o of orders || []) {
    const createdMs = Number(o?.created || 0);
    if (startMs && createdMs && createdMs < startMs) continue;
    if (endMs && createdMs && createdMs >= endMs) continue;

    for (const li of o?.lines || []) {
      const cat = String(li?.category || "").toLowerCase();
      if (!cats.has(cat)) continue;
      const m = li?.meta || {};
      out.push({
        date: new Date(o.created || Date.now()).toISOString(),
        purchaser: o?.purchaser?.name || o?.customer_email || "",
        attendee: m.attendeeName || "",
        attendee_title: m.attendeeTitle || "",
        attendee_phone: m.attendeePhone || "",
        attendee_email: m.attendeeEmail || "",
        item: li?.itemName || "",
        item_id: li?.itemId || "",
        qty: li?.qty || 1,
        notes:
          cat === "banquet"
            ? [m.attendeeNotes, m.dietaryNote].filter(Boolean).join("; ")
            : m.itemNote || "",
        attendee_addr1: includeAddress ? m.attendeeAddr1 || "" : "",
        attendee_addr2: includeAddress ? m.attendeeAddr2 || "" : "",
        attendee_city: includeAddress ? m.attendeeCity || "" : "",
        attendee_state: includeAddress ? m.attendeeState || "" : "",
        attendee_postal: includeAddress ? m.attendeePostal || "" : "",
        attendee_country: includeAddress ? m.attendeeCountry || "" : "",
      });
    }
  }
  return out;
}

// ---- single function that sends a chair XLSX for a given item ----
async function sendItemReportEmailInternal({
  kind,
  id,
  label,
  scope = "current-month",
}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!kind || !id) return { ok: false, error: "missing-kind-or-id" };

  // NEW: load all orders with a small retry window (helps cold start / timing issues)
  const orders = await loadAllOrdersWithRetry();

  let startMs, endMs;
  if (scope === "current-month") {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    startMs = start.getTime();
    endMs = Date.now() + 1;
  }

  const base = baseKey(id);
  const includeAddressForThisItem = base === "pre-reg" || base === "directory";

  const rosterAll = collectAttendeesFromOrders(orders, {
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
        String(r.item || "")
          .toLowerCase()
          .includes(String(label).toLowerCase()))
  );

  let EMAIL_COLUMNS = [
    "#",
    "date",
    "attendee",
    "attendee_title",
    "attendee_phone",
    "item",
    "qty",
    "notes",
  ];

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

  const sorted = sortByDateAsc(filtered, "date");
  let counter = 1;

  const numbered = sorted.map((r) => {
    const hasAttendee = String(r.attendee || "").trim().length > 0;
    const baseRow = {
      "#": hasAttendee ? counter++ : "",
      date: r.date,
      attendee: r.attendee,
      attendee_title: r.attendee_title,
      attendee_phone: r.attendee_phone,
    };

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
        item: r.item,
        qty: r.qty,
        notes: r.notes,
      };
    }

    return {
      ...baseRow,
      item: r.item,
      qty: r.qty,
      notes: r.notes,
    };
  });

  const xlsxBuf = await objectsToXlsxBuffer(
    EMAIL_COLUMNS,
    numbered,
    EMAIL_HEADER_LABELS,
    "Item Report"
  );
  const xlsxB64 = Buffer.from(xlsxBuf).toString("base64");

  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const baseNameRaw = label || id || "report";
  const baseName = baseNameRaw
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");

  const filename = `${baseName || "report"}_${dateStr}.xlsx`;

  const toListPref = await getChairEmailsForItemId(id);

  const { effective } = await getEffectiveSettings();

  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const envFallback = safeSplit(
    effective.REPORTS_CC ||
      effective.REPORTS_BCC ||
      process.env.REPORTS_CC ||
      process.env.REPORTS_BCC ||
      ""
  );

  const toList = toListPref.length ? toListPref : envFallback;

  const adminBccBase = safeSplit(
    effective.REPORTS_BCC ||
      effective.REPORTS_CC ||
      process.env.REPORTS_BCC ||
      process.env.REPORTS_CC ||
      ""
  );
  const bccList = adminBccBase.filter(
    (addr) => !toList.includes(addr)
  );

  if (!toList.length && !bccList.length)
    return { ok: false, error: "no-recipient" };

  const prettyKind = kind === "other" ? "catalog" : kind;

  // NEW: nicer human scope label + explanation for current-month
  const scopeLabel =
    scope === "current-month"
      ? "current-month (from the first of the month through today)"
      : scope === "full"
        ? "full (all orders for this item)"
        : String(scope || "");

  const extraScopeLine =
    scope === "current-month"
      ? `<p style="font-size:12px;color:#555;margin:2px 0 0;"><strong>These reports include all activity from the first of the month through today.</strong></p>`
      : "";

  const subject = `Report — ${prettyKind}: ${label || id}`;
  const tablePreview = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
      <p>Attached is the Excel report for <b>${prettyKind}</b> “${
        label || id
      }”.</p>
      <p>Rows: <b>${sorted.length}</b></p>
      <div style="font-size:12px;color:#555">Scope: ${scopeLabel}</div>
      ${extraScopeLine}
    </div>`;

  const payload = {
    from: RESEND_FROM,
    to: toList.length ? toList : bccList,
    bcc: toList.length && bccList.length ? bccList : undefined,
    subject,
    html: tablePreview,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename,
        content: xlsxB64,
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `item-report:${kind}:${id}`
  );

  if (retry.ok) {
    const sendResult = retry.result;
    await recordMailLog({
      ts: Date.now(),
      from: RESEND_FROM,
      to: [...toList, ...bccList],
      subject,
      resultId: sendResult?.id || null,
      kind: "item-report",
      status: "queued",
    });
    return { ok: true, count: sorted.length, to: toList, bcc: bccList };
  } else {
    const err = retry.error;
    await recordMailLog({
      ts: Date.now(),
      from: RESEND_FROM,
      to: [...toList, ...bccList],
      subject,
      resultId: null,
      kind: "item-report",
      status: "error",
      error: String(err?.message || err),
    });
    return {
      ok: false,
      error: "send-failed",
      message: err?.message || String(err),
    };
  }
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

    const isCatalog =
      cat === "catalog" || metaType === "catalog";

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

// ------------- EXPORTS -------------
export {
  // raw kv (for smoketest)
  kv,

  // env / clients
  getStripe,
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,

  // generic helpers
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
};
