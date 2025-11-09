// /api/router.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";

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
function toCentsAuto(v){ const n = Number(v || 0); return n < 1000 ? Math.round(n * 100) : Math.round(n); }

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
const normalizeKey = s => String(s || "").toLowerCase().replace(/:(adult|child|youth)$/i, "");

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
  const effective = { ...env, ...overrides,
    MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true"
  };
  return { env, overrides, effective };
}
function filterRowsByWindow(rows, { startMs, endMs }) {
  if (!rows?.length) return rows || [];
  return rows.filter(r => {
    const t = parseDateISO(r.date);
    if (isNaN(t)) return false;
    if (startMs && t < startMs) return false;
    if (endMs   && t >= endMs)  return false;
    return true;
  });
}

// Apply category / item filters (used by /orders, /orders_csv, and send_item_report)
function applyItemFilters(rows, { category, item_id, item }) {
  let out = rows || [];

  if (category) {
    const cat = String(category).toLowerCase();
    out = out.filter(r => String(r.category || "").toLowerCase() === cat);
  }

  if (item_id) {
    const wantNorm = normalizeKey(item_id);
    out = out.filter(r => {
      const raw = String(r._itemId || r.item_id || "").toLowerCase();
      const rawNorm = normalizeKey(raw);
      const keyNorm = normalizeKey(r._itemKey || "");
      return raw === String(item_id).toLowerCase() || rawNorm === wantNorm || keyNorm === wantNorm;
    });
  } else if (item) {
    const want = String(item).toLowerCase();
    out = out.filter(r => String(r.item || "").toLowerCase().includes(want));
  }

  return out;
}

// --- Mail visibility helpers ---
const MAIL_LOG_KEY = "mail:lastlog";
async function recordMailLog(payload) { try { await kv.set(MAIL_LOG_KEY, payload, { ex: 3600 }); } catch {} }

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
    expand: ["payment_intent", "customer_details"]
  });
  const liResp = await stripe.checkout.sessions.listLineItems(sid, {
    limit: 100,
    expand: ["data.price.product"]
  });
  const lineItems = liResp?.data || [];
  return { session: s, lineItems };
}

// ----- order persistence helpers -----
async function saveOrderFromSession(sessionLike) {
  const stripe = await getStripe();
  if (!stripe) throw new Error("stripe-not-configured");

  const sid = typeof sessionLike === "string" ? sessionLike : sessionLike.id;
  const { session: s, lineItems } = await fetchSessionAndItems(stripe, sid);

  const lines = lineItems.map((li) => {
    const name  = li.description || li.price?.product?.name || "Item";
    const qty   = Number(li.quantity || 1);
    const unit  = cents(li.price?.unit_amount || 0); // Stripe returns cents
    const total = unit * qty;
    const meta  = (li.price?.product?.metadata || {});
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
        attendeeNotes: meta.attendeeNotes || "",
        dietaryNote: meta.dietaryNote || "",
        itemNote: meta.itemNote || "",
        priceMode: meta.priceMode || "",
        bundleQty: meta.bundleQty || "",
        bundleTotalCents: meta.bundleTotalCents || ""
      },
      notes: ""
    };
  });

  const order = {
    id: sid,
    created: Date.now(),
    payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || "",
    charge: null,
    currency: s.currency || "usd",
    amount_total: cents(s.amount_total || 0),
    customer_email: s.customer_details?.email || "",
    purchaser: {
      name: s.customer_details?.name || "",
      phone: s.customer_details?.phone || ""
    },
    lines,
    fees: { pct: 0, flat: 0 },
    refunds: [],
    refunded_cents: 0,
    status: "paid"
  };

  const piId = order.payment_intent;
  if (piId) {
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["charges.data"] }).catch(()=>null);
    if (pi?.charges?.data?.length) order.charge = pi.charges.data[0].id;
  }

  await kvSetSafe(`order:${order.id}`, order);
  await kvSaddSafe("orders:index", order.id); // stored in a Redis SET
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
        created: refund.created ? refund.created * 1000 : Date.now()
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
  (o.lines || []).forEach(li => {
    const net = li.gross;
    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: li.meta?.attendeeName || "",
      category: li.category || 'other',
      item: li.itemName || '',
      item_id: li.itemId || '', // public field (kept for backward-compat)
      qty: li.qty || 1,
      price: (li.unitPrice || 0) / 100,
      gross: (li.gross || 0) / 100,
      fees: 0,
      net: (net || 0) / 100,
      status: o.status || "paid",
      notes: li.category === "banquet"
        ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
        : (li.meta?.itemNote || ""),

      // NEW hidden keys used for filtering
      _itemId: li.itemId || "",
      _itemKey: String(li.itemId || "").replace(/:(adult|child|youth)$/i, ""),
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id
    });
  });

  // Include a distinct fee row (if present)
  const feeLine = (o.lines || []).find(li => /processing fee/i.test(li.itemName || ""));
  if (feeLine) {
    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "",
      category: 'other',
      item: feeLine.itemName || 'Processing Fee',
      item_id: '',
      qty: feeLine.qty || 1,
      price: (feeLine.unitPrice || 0) / 100,
      gross: (feeLine.gross || 0) / 100,
      fees: 0,
      net: (feeLine.gross || 0) / 100,
      status: o.status || "paid",
      notes: "",
      // hidden keys present but empty for fees
      _itemId: "",
      _itemKey: "",
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id
    });
  }
  return rows;
}

// -------- Email rendering + sending (receipts) --------
function absoluteUrl(path = "/") {
  const base = (process.env.SITE_BASE_URL || "").replace(/\/+$/,"");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

function renderOrderEmailHTML(order) {
  const money = (c) => (Number(c||0)/100).toLocaleString("en-US",{style:"currency",currency:"USD"});
  const logoUrl = absoluteUrl("/assets/img/receipt_logo.svg");
  const purchaserName = order?.purchaser?.name || "Purchaser";

  const topCatalog = [];
  const attendeeGroups = {};
  let feesCents = 0;

  (order.lines || []).forEach(li => {
    const name = li.itemName || "";
    const qty = Number(li.qty || 1);
    const lineCents = Number(li.unitPrice || 0) * qty;
    const cat = String(li.category || "").toLowerCase();

    if (/processing\s*fee/i.test(name)) { feesCents += lineCents; return; }

    const isBanquet = (cat === "banquet") || /banquet/i.test(name);
    const isAddon   = (cat === "addon")   || /addon/i.test(li.meta?.itemType || "") || /addon/i.test(name);

    if (isBanquet || isAddon) {
      const attName = (li.meta && li.meta.attendeeName) || purchaserName;
      (attendeeGroups[attName] ||= []).push(li);
    } else {
      topCatalog.push(li);
    }
  });

  const renderTable = (rows) => {
    const bodyRows = rows.map(li => {
      const cat = String(li.category || "").toLowerCase();
      const isBanquet = (cat === "banquet") || /banquet/i.test(li.itemName || "");
      const notes = isBanquet
        ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
        : (li.meta?.itemNote || "");
      const notesRow = notes
        ? `<div style="font-size:12px;color:#444;margin-top:2px">Notes: ${String(notes).replace(/</g,"&lt;")}</div>`
        : "";
      const lineTotal = Number(li.unitPrice||0) * Number(li.qty||1);
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee">
            ${li.itemName || ""}${notesRow}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(li.qty||1)}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(li.unitPrice||0)}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(lineTotal)}</td>
        </tr>`;
    }).join("");

    const subtotal = rows.reduce((s,li)=> s + Number(li.unitPrice||0)*Number(li.qty||1), 0);

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
            <td style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">${money(subtotal)}</td>
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

  const attendeeHtml = Object.entries(attendeeGroups).map(([attName, list]) => `
    <div style="margin-top:14px">
      <div style="font-weight:700;margin:8px 0 6px">${attName} — Banquets & Addons</div>
      ${renderTable(list)}
    </div>`).join("");

  const subtotalAll = (order.lines||[]).reduce((s,li)=> s + Number(li.unitPrice||0)*Number(li.qty||1), 0);
  const total = Number(order.amount_total || subtotalAll);
  const feesRow = feesCents > 0
    ? `<tr>
         <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">Fees</td>
         <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(feesCents)}</td>
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
    ${attendeeHtml || '<p>No items.</p>'}

    <table style="width:100%;border-collapse:collapse;margin-top:12px">
      <tfoot>
        ${feesRow}
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:2px solid ${feesRow ? "#ddd" : "#ddd"};font-weight:700">Total</td>
          <td style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">${money(total)}</td>
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
  ).split(",").map(s=>s.trim()).filter(Boolean);

  if (purchaserEmail) {
    try {
      const sendResult = await resend.emails.send({
        from: RESEND_FROM,
        to: [purchaserEmail],
        subject,
        html,
        reply_to: REPLY_TO || undefined
      });
      await recordMailLog({ ts: Date.now(), from: RESEND_FROM, to: [purchaserEmail], subject, orderId: order?.id || "", resultId: sendResult?.id || null, status: "queued" });
    } catch (err) {
      await recordMailLog({ ts: Date.now(), from: RESEND_FROM, to: [purchaserEmail], subject, orderId: order?.id || "", resultId: null, status: "error", error: String(err?.message || err) });
    }
  }

  if (adminList.length) {
    try {
      const sendResult = await resend.emails.send({
        from: RESEND_FROM,
        to: adminList,
        subject: `${subject} (admin copy)`,
        html,
        reply_to: REPLY_TO || undefined
      });
      await recordMailLog({ ts: Date.now(), from: RESEND_FROM, to: adminList, subject: `${subject} (admin copy)`, orderId: order?.id || "", resultId: sendResult?.id || null, status: "queued" });
    } catch (err) {
      await recordMailLog({ ts: Date.now(), from: RESEND_FROM, to: adminList, subject: `${subject} (admin copy)`, orderId: order?.id || "", resultId: null, status: "error", error: String(err?.message || err) });
    }
  }

  if (!purchaserEmail && !adminList.length) return { sent: false, reason: "no-recipients" };
  return { sent: true };
}

// --------- Helpers to build CSV for exports/emails ----------
function buildCSV(rows) {
  const headers = Object.keys(rows[0] || {
    id: "", date: "", purchaser: "", attendee: "", category: "", item: "", item_id: "",
    qty: 0, price: 0, gross: 0, fees: 0, net: 0, status: "", notes: "",
    _itemId: "", _itemKey: "", _pi: "", _charge: "", _session: ""
  });
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map(r => headers.map(h => esc(r[h])).join(","))
  ].join("\n");
  // Prepend BOM so Excel reads UTF-8 (fixes Entrée)
  return "\uFEFF" + csv;
}

// -------------- (start of main handler) --------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get("action");
    const type  = url.searchParams.get("type");

    // ---------- GET ----------
    if (req.method === "GET") {

      // --- Smoketest ---
      if (type === "smoketest") {
        const out = {
          ok: true,
          node: process.versions?.node || "unknown",
          runtime: process.env.VERCEL ? "vercel" : "local",
          hasSecret: !!process.env.STRIPE_SECRET_KEY,
          hasPub: !!process.env.STRIPE_PUBLISHABLE_KEY,
          hasWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
          hasResendEnv: !!process.env.RESEND_API_KEY,
          hasResendClient: !!resend,
          fromTrimmed: RESEND_FROM,
          kvSetGetOk: false,
        };
        try { await kv.set("smoketest:key", "ok", { ex: 30 }); } catch (e) {}
        try {
          const v = await kv.get("smoketest:key");
          out.kvSetGetOk = (v === "ok");
        } catch (e) { out.kvError = String(e?.message || e); }
        return REQ_OK(res, out);
      }

      // --- Last sent mail visibility
      if (type === "lastmail") {
        const data = await kvGetSafe(MAIL_LOG_KEY, { note: "no recent email log" });
        return REQ_OK(res, data);
      }

      if (type === "banquets")  return REQ_OK(res, { banquets: (await kvGetSafe("banquets")) || [] });
      if (type === "addons")    return REQ_OK(res, { addons: (await kvGetSafe("addons")) || [] });
      if (type === "products")  return REQ_OK(res, { products: (await kvGetSafe("products")) || [] });

      if (type === "settings") {
        const { env, overrides, effective } = await getEffectiveSettings();
        return REQ_OK(res, {
          env, overrides, effective,
          MAINTENANCE_ON: effective.MAINTENANCE_ON,
          MAINTENANCE_MESSAGE: effective.MAINTENANCE_MESSAGE || env.MAINTENANCE_MESSAGE
        });
      }

      // Publishable key
      if (type === "stripe_pubkey" || type === "stripe_pk") {
        return REQ_OK(res, { publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "" });
      }

      if (type === "checkout_session") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");
        const id = url.searchParams.get("id");
        if (!id) return REQ_ERR(res, 400, "missing-id");
        const s = await stripe.checkout.sessions.retrieve(id, { expand: ["payment_intent"] });
        return REQ_OK(res, {
          id: s.id,
          amount_total: s.amount_total,
          currency: s.currency,
          customer_details: s.customer_details || {},
          payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id
        });
      }

      // ----- Orders (JSON) -----
      if (type === "orders") {
        const ids = await kvSmembersSafe("orders:index");
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
        }

        // query params
        const daysParam  = url.searchParams.get("days");   // ?days=7
        const startParam = url.searchParams.get("start");  // ?start=2025-11-01
        const endParam   = url.searchParams.get("end");    // ?end=2025-11-10

        // settings fallback
        const { effective } = await getEffectiveSettings();
        const cfgDays  = Number(effective.REPORT_ORDER_DAYS || 0) || 0;
        const cfgStart = effective.EVENT_START || "";
        const cfgEnd   = effective.EVENT_END || "";

        let startMs = NaN;
        let endMs   = NaN;

        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs   = parseYMD(endParam);
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs = endMs - Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
          } else {
            startMs = parseYMD(cfgStart);
            endMs   = parseYMD(cfgEnd);
          }
        }

        let rows = all;
        if (!isNaN(startMs) || !isNaN(endMs)) {
          rows = filterRowsByWindow(rows, {
            startMs: isNaN(startMs) ? undefined : startMs,
            endMs:   isNaN(endMs)   ? undefined : endMs
          });
        }

        // Optional fuzzy text search (?q=Linda / beef / vegetarian)
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (q) {
          rows = rows.filter(r =>
            String(r.purchaser||"").toLowerCase().includes(q) ||
            String(r.attendee||"").toLowerCase().includes(q) ||
            String(r.item||"").toLowerCase().includes(q) ||
            String(r.category||"").toLowerCase().includes(q) ||
            String(r.status||"").toLowerCase().includes(q) ||
            String(r.notes||"").toLowerCase().includes(q)
          );
        }

        // NEW precise filters (normalized)
        const catParam    = (url.searchParams.get("category") || "").toLowerCase();
        const itemIdParam = (url.searchParams.get("item_id")  || "").toLowerCase();
        const itemParam   = (url.searchParams.get("item")     || "").toLowerCase();

        if (catParam) {
          rows = rows.filter(r => String(r.category || "").toLowerCase() === catParam);
        }

        if (itemIdParam) {
          const want = normalizeKey(itemIdParam);
          rows = rows.filter(r => {
            const raw   = String(r._itemId || r.item_id || "").toLowerCase();
            const rawNorm = normalizeKey(raw);
            const keyNorm = normalizeKey(r._itemKey || "");
            return raw === itemIdParam || rawNorm === want || keyNorm === want;
          });
        } else if (itemParam) {
          const want = itemParam;
          rows = rows.filter(r => String(r.item || "").toLowerCase().includes(want));
        }

        rows.sort((a,b) => {
          const ta = parseDateISO(a.date);
          const tb = parseDateISO(b.date);
          return (isNaN(tb)?0:tb) - (isNaN(ta)?0:ta);
        });

        return REQ_OK(res, { rows });
      }

      // ----- Orders (CSV) -----
      if (type === "orders_csv") {
        // Build the same filtered list as /orders
        const ids = await kvSmembersSafe("orders:index");
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
        }

        const daysParam  = url.searchParams.get("days");
        const startParam = url.searchParams.get("start");
        const endParam   = url.searchParams.get("end");

        const { effective } = await getEffectiveSettings();
        const cfgDays  = Number(effective.REPORT_ORDER_DAYS || 0) || 0;
        const cfgStart = effective.EVENT_START || "";
        const cfgEnd   = effective.EVENT_END || "";

        let startMs = NaN;
        let endMs   = NaN;

        if (daysParam) {
          const n = Math.max(1, Number(daysParam) || 0);
          endMs = Date.now() + 1;
          startMs = endMs - n * 24 * 60 * 60 * 1000;
        } else if (startParam || endParam) {
          startMs = parseYMD(startParam);
          endMs   = parseYMD(endParam);
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs = endMs - Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
          } else {
            startMs = parseYMD(cfgStart);
            endMs   = parseYMD(cfgEnd);
          }
        }

        let rows = all;
        if (!isNaN(startMs) || !isNaN(endMs)) {
          rows = filterRowsByWindow(rows, {
            startMs: isNaN(startMs) ? undefined : startMs,
            endMs:   isNaN(endMs)   ? undefined : endMs
          });
        }

        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (q) {
          rows = rows.filter(r =>
            String(r.purchaser||"").toLowerCase().includes(q) ||
            String(r.attendee||"").toLowerCase().includes(q) ||
            String(r.item||"").toLowerCase().includes(q) ||
            String(r.category||"").toLowerCase().includes(q) ||
            String(r.status||"").toLowerCase().includes(q) ||
            String(r.notes||"").toLowerCase().includes(q)
          );
        }

        // NEW precise filters (normalized)
        const catParam    = (url.searchParams.get("category") || "").toLowerCase();
        const itemIdParam = (url.searchParams.get("item_id")  || "").toLowerCase();
        const itemParam   = (url.searchParams.get("item")     || "").toLowerCase();

        if (catParam) {
          rows = rows.filter(r => String(r.category || "").toLowerCase() === catParam);
        }

        if (itemIdParam) {
          const want = normalizeKey(itemIdParam);
          rows = rows.filter(r => {
            const raw   = String(r._itemId || r.item_id || "").toLowerCase();
            const rawNorm = normalizeKey(raw);
            const keyNorm = normalizeKey(r._itemKey || "");
            return raw === itemIdParam || rawNorm === want || keyNorm === want;
          });
        } else if (itemParam) {
          const want = itemParam;
          rows = rows.filter(r => String(r.item || "").toLowerCase().includes(want));
        }

        rows.sort((a,b) => {
          const ta = parseDateISO(a.date);
          const tb = parseDateISO(b.date);
          return (isNaN(tb)?0:tb) - (isNaN(ta)?0:ta);
        });

        const csv = buildCSV(rows);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="orders.csv"`);
        return res.status(200).send(csv);
      }

      // Idempotent finalize via GET
      if (type === "finalize_order") {
        const sid = String(url.searchParams.get("sid") || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid");
        try {
          const order = await saveOrderFromSession({ id: sid });
          (async () => { try { await sendOrderReceipts(order); } catch (e) {} })();
          return REQ_OK(res, { ok: true, orderId: order.id, status: order.status || "paid" });
        } catch (err) {
          console.error("finalize_order failed:", err);
          return REQ_ERR(res, 500, "finalize-failed", { detail: String(err?.message || err) });
        }
      }

      // Fetch one saved order
      if (type === "order") {
        const oid = String(url.searchParams.get("oid") || "").trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid");
        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found");
        return REQ_OK(res, { order });
      }

      return REQ_ERR(res, 400, "unknown-type");
    }

    // ---------- POST ----------
    if (req.method === "POST") {
      const body = (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));

      // --- Quick manual Resend test (no auth) ---
      if (action === "test_resend") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured");
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const bodyTo = (body && body.to) || urlObj.searchParams.get("to") || "";
        const fallbackAdmin = (process.env.REPORTS_BCC || process.env.REPORTS_CC || "").split(",").map(s=>s.trim()).filter(Boolean)[0] || "";
        const to = (bodyTo || fallbackAdmin).trim();
        if (!to) return REQ_ERR(res, 400, "missing-to");

        const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
          <h2>Resend test OK</h2>
          <p>Time: ${new Date().toISOString()}</p>
          <p>From: ${RESEND_FROM || ""}</p>
        </div>`;

        try {
          const sendResult = await resend.emails.send({
            from: RESEND_FROM || "onboarding@resend.dev",
            to: [to],
            subject: "Amaranth test email",
            html,
            reply_to: REPLY_TO || undefined
          });
          await recordMailLog({ ts: Date.now(), from: RESEND_FROM || "onboarding@resend.dev", to: [to], subject: "Amaranth test email", resultId: sendResult?.id || null, kind: "manual-test", status: "queued" });
          return REQ_OK(res, { ok: true, id: sendResult?.id || null, to });
        } catch (e) {
          await recordMailLog({ ts: Date.now(), from: RESEND_FROM || "onboarding@resend.dev", to: [to], subject: "Amaranth test email", resultId: null, kind: "manual-test", status: "error", error: String(e?.message || e) });
          return REQ_ERR(res, 500, "resend-send-failed", { message: e?.message || String(e) });
        }
      }

      // --- Finalize (save + email) from success page ---
      if (action === "finalize_checkout") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");
        const sid = String(body.sid || body.id || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid");
        const order = await saveOrderFromSession({ id: sid });
        await sendOrderReceipts(order);
        return REQ_OK(res, { ok: true, orderId: order.id });
      }

      // ---- CREATE CHECKOUT (with BUNDLE PROTECTION) ----
      if (action === "create_checkout_session") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");

        const origin = req.headers.origin || `https://${req.headers.host}`;
        const successUrl = (body.success_url || `${origin}/success.html`) + `?sid={CHECKOUT_SESSION_ID}`;
        const cancelUrl  = body.cancel_url  || `${origin}/order.html`;

        if (Array.isArray(body.lines) && body.lines.length) {
          const lines = body.lines;
          const fees = body.fees || { pct: 0, flat: 0 };
          const purchaser = body.purchaser || {};

          const line_items = lines.map(l => {
            const priceMode = (l.priceMode || "").toLowerCase();
            const isBundle  = priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;

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
                    attendeeNotes: l.meta?.attendeeNotes || "",
                    dietaryNote: l.meta?.dietaryNote || "",
                    itemNote: l.meta?.itemNote || "",
                    priceMode: priceMode || "",
                    bundleQty: isBundle ? String(l.bundleQty || "") : "",
                    bundleTotalCents: isBundle ? String(unit_amount) : ""
                  }
                }
              }
            };
          });

          const pct       = Number(fees.pct || 0);
          const flatCents = toCentsAuto(fees.flat || 0);
          const subtotalCents = lines.reduce((s,l)=>{
            const priceMode = (l.priceMode || "").toLowerCase();
            const isBundle  = priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;
            if (isBundle) {
              return s + cents(l.bundleTotalCents || 0);
            } else {
              return s + toCentsAuto(l.unitPrice || 0) * Number(l.qty || 0);
            }
          }, 0);

          const feeAmount = Math.max(0, Math.round(subtotalCents * (pct/100)) + flatCents);
          if (feeAmount > 0) {
            line_items.push({
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: feeAmount,
                product_data: { name: "Processing Fee" }
              }
            });
          }

          const session = await getStripe().then(stripe =>
            stripe.checkout.sessions.create({
              mode: "payment",
              line_items,
              customer_email: purchaser.email || undefined,
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: {
                purchaser_name: purchaser.name || "",
                purchaser_phone: purchaser.phone || "",
                purchaser_title: purchaser.title || "",
                purchaser_city: purchaser.city || "",
                purchaser_state: purchaser.state || "",
                purchaser_postal: purchaser.postal || "",
                cart_count: String(lines.length || 0)
              }
            })
          );

          return REQ_OK(res, { url: session.url, id: session.id });
        }

        // Legacy branch (simple items)
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) return REQ_ERR(res, 400, "no-items");

        const session = await getStripe().then(stripe =>
          stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            line_items: items.map(it => ({
              quantity: Math.max(1, Number(it.quantity || 1)),
              price_data: {
                currency: "usd",
                unit_amount: dollarsToCents(it.price || 0),
                product_data: { name: String(it.name || "Item") }
              }
            })),
            success_url: successUrl,
            cancel_url: cancelUrl
          })
        );
        return REQ_OK(res, { url: session.url, id: session.id });
      }

      // ---- Stripe webhook ----
      if (action === "stripe_webhook") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");

        let event;
        const sig = req.headers["stripe-signature"];
        const whsec = process.env.STRIPE_WEBHOOK_SECRET || "";

        try {
          if (whsec && typeof req.body === "string") {
            event = stripe.webhooks.constructEvent(req.body, sig, whsec);
          } else if (whsec && req.rawBody) {
            event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec);
          } else {
            event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
          }
        } catch (err) {
          console.error("Webhook signature verification failed:", err?.message);
          return REQ_ERR(res, 400, "invalid-signature");
        }

        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const order = await saveOrderFromSession(session.id || session);
            (async () => {
              try { await sendOrderReceipts(order); }
              catch (err) { console.error("email-failed", err?.message || err); }
            })();
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

        return REQ_OK(res, { received: true });
      }

      // --- PUBLIC: register an item config (chairs/addons/products/banquets) ---
      if (action === "register_item") {
        const {
          id = "",
          name = "",
          chairEmails = [],
          publishStart = "",
          publishEnd = ""
        } = body || {};
        if (!id || !name) return REQ_ERR(res, 400, "id-and-name-required");

        const cfg = {
          id,
          name,
          chairEmails: (Array.isArray(chairEmails) ? chairEmails : String(chairEmails).split(","))
            .map(s => String(s||"").trim()).filter(Boolean),
          publishStart,
          publishEnd,
          updatedAt: new Date().toISOString()
        };

        const ok1 = await kvHsetSafe(`itemcfg:${id}`, cfg);
        const ok2 = await kvSaddSafe("itemcfg:index", id);
        if (!ok1 || !ok2) return REQ_OK(res, { ok: true, warning: "kv-unavailable" });

        return REQ_OK(res, { ok: true });
      }

      // -------- ADMIN (auth required below) --------
      if (!requireToken(req, res)) return;

      // Manual report sends (hook to existing scripts)
      if (action === "send_full_report") {
        try {
          const mod = await import("./admin/send-full.js");
          const result = await mod.default();
          return REQ_OK(res, result || { ok: true });
        } catch (e) {
          return REQ_ERR(res, 500, "send-full-failed", { message: e?.message || String(e) });
        }
      }
      if (action === "send_month_to_date") {
        try {
          const mod = await import("./admin/send-month-to-date.js");
          const result = await mod.default();
          return REQ_OK(res, result || { ok: true });
        } catch (e) {
          return REQ_ERR(res, 500, "send-mtd-failed", { message: e?.message || String(e) });
        }
      }

      // Clear only the index set (orders remain saved under order:<id>)
      if (action === "clear_orders") {
        await kvDelSafe("orders:index");
        return REQ_OK(res, { ok: true, message: "orders index cleared" });
      }

      // create_refund
      if (action === "create_refund") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");
        const payment_intent = String(body.payment_intent || "").trim();
        const charge = String(body.charge || "").trim();
        const amount_cents_raw = body.amount_cents;
        const args = {};
        if (amount_cents_raw != null) args.amount = cents(amount_cents_raw);
        if (payment_intent) args.payment_intent = payment_intent;
        else if (charge) args.charge = charge;
        else return REQ_ERR(res, 400, "missing-payment_intent-or-charge");

        const rf = await stripe.refunds.create(args);
        try { await applyRefundToOrder(rf.charge, rf); } catch {}
        return REQ_OK(res, { ok: true, id: rf.id, status: rf.status });
      }

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets) ? body.banquets : [];
        await kvSetSafe("banquets", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_addons") {
        const list = Array.isArray(body.addons) ? body.addons : [];
        await kvSetSafe("addons", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_products") {
        const list = Array.isArray(body.products) ? body.products : [];
        await kvSetSafe("products", list);
        return REQ_OK(res, { ok: true, count: list.length });
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
          "REPORT_ORDER_DAYS"
        ].forEach(k => { if (k in body) allow[k] = body[k]; });

        if ("MAINTENANCE_ON" in allow) {
          allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
        }

        if (Object.keys(allow).length) {
          await kvHsetSafe("settings:overrides", allow);
        }
        return REQ_OK(res, { ok: true, overrides: allow });
      }

      return REQ_ERR(res, 400, "unknown-action");
    }

    // ---------- PUBLIC (no auth) actions ----------
    if (req.method === "POST" && action === "send_item_report") {
      // Expected body: { kind: 'banquet'|'addon'|'other', id: 'item-id', label: 'Human Name', scope: 'current-month'|'full' }
      if (!resend) return REQ_ERR(res, 500, "resend-not-configured");

      const kind  = String((req.body?.kind || req.body?.category || "")).toLowerCase();
      const id    = String(req.body?.id || "").trim();
      const label = String(req.body?.label || "").trim();
      const scope = String(req.body?.scope || "current-month");

      if (!kind || !id) return REQ_ERR(res, 400, "missing-kind-or-id");

      // Collect all rows, then filter the same way /orders_csv does
      const ids = await kvSmembersSafe("orders:index");
      let all = [];
      for (const sid of ids) {
        const o = await kvGetSafe(`order:${sid}`, null);
        if (o) all.push(...flattenOrderToRows(o));
      }

      // Optional scope: current month vs full
      let startMs, endMs;
      if (scope === "current-month") {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        startMs = start.getTime();
        endMs = Date.now() + 1;
      }

      let rows = all;
      if (startMs || endMs) {
        rows = filterRowsByWindow(rows, { startMs, endMs });
      }
      rows = applyItemFilters(rows, { category: kind, item_id: id, item: label });

      // Build CSV
      const csv = buildCSV(rows);

      // Find recipients from itemcfg:<id>
      const cfg = await kvHgetallSafe(`itemcfg:${id}`);
      const chairEmails = (cfg?.chairEmails && Array.isArray(cfg.chairEmails))
        ? cfg.chairEmails
        : String(cfg?.chairEmails || "").split(",").map(s=>s.trim()).filter(Boolean);

      const fallback = (process.env.REPORTS_CC || process.env.REPORTS_BCC || "")
        .split(",").map(s=>s.trim()).filter(Boolean);

      const toList = (chairEmails.length ? chairEmails : fallback);
      if (!toList.length) return REQ_ERR(res, 400, "no-recipient");

      const prettyKind = kind === "other" ? "catalog" : kind;
      const subject = `Report — ${prettyKind}: ${label || id}`;
      const tablePreview = `
        <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
          <p>Attached is the CSV for <b>${prettyKind}</b> “${label || id}”.</p>
          <p>Rows: <b>${rows.length}</b></p>
          <div style="font-size:12px;color:#555">Scope: ${scope}</div>
        </div>`;

      try {
        // Resend attachments want base64
        const csvB64 = Buffer.from(csv, "utf8").toString("base64");
        const sendResult = await resend.emails.send({
          from: RESEND_FROM,
          to: toList,
          subject,
          html: tablePreview,
          reply_to: REPLY_TO || undefined,
          attachments: [{ filename: "report.csv", content: csvB64 }]
        });
        await recordMailLog({ ts: Date.now(), from: RESEND_FROM, to: toList, subject, resultId: sendResult?.id || null, kind: "item-report", status: "queued" });
        return REQ_OK(res, { ok: true, count: rows.length, to: toList });
      } catch (e) {
        await recordMailLog({ ts: Date.now(), from: RESEND_FROM, to: toList, subject, resultId: null, kind: "item-report", status: "error", error: String(e?.message || e) });
        return REQ_ERR(res, 500, "send-failed", { message: e?.message || String(e) });
      }
    }

    return REQ_ERR(res, 405, "method-not-allowed");
  } catch (e) {
    console.error(e);
    return REQ_ERR(res, 500, "router-failed", { message: e?.message || String(e) });
  }
}

// Vercel Node 22 runtime
export const config = { runtime: "nodejs" };
