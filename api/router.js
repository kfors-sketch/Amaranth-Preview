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

const REQ_OK  = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });

// ---------- helpers ----------
function cents(n) { return Math.round(Number(n || 0)); }
function dollarsToCents(n) { return Math.round(Number(n || 0) * 100); }
// Auto dollars→cents if small integer
function toCentsAuto(v){ const n = Number(v || 0); return n < 1000 ? Math.round(n * 100) : Math.round(n); }

async function kvGetSafe(key, fallback = null) { try { return await kv.get(key); } catch { return fallback; } }
async function kvHsetSafe(key, obj)          { try { await kv.hset(key, obj); return true; } catch { return false; } }
async function kvSaddSafe(key, val)          { try { await kv.sadd(key, val); return true; } catch { return false; } }
async function kvSetSafe(key, val)           { try { await kv.set(key, val);  return true; } catch { return false; } }
async function kvHgetallSafe(key)            { try { return (await kv.hgetall(key)) || {}; } catch { return {}; } }

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

// ----- order persistence helpers -----
async function saveOrderFromSession(sessionLike) {
  const stripe = await getStripe();
  if (!stripe) throw new Error("stripe-not-configured");

  const s = await stripe.checkout.sessions.retrieve(sessionLike.id, {
    expand: ["line_items.data.price.product", "payment_intent"],
  });

  const lines = (s.line_items?.data || []).map(li => {
    const name  = li.description || li.price?.product?.name || "Item";
    const qty   = Number(li.quantity || 1);
    const unit  = cents(li.price?.unit_amount || 0); // Stripe returns cents
    const total = unit * qty;
    const meta  = (li.price?.product?.metadata || {});
    return {
      id: `${s.id}:${li.id}`,
      itemName: name,
      qty,
      unitPrice: unit,
      gross: total,
      category: (meta.itemType || '').toLowerCase() || 'other',
      notes: meta.notes || "",               // NEW
      attendeeId: meta.attendeeId || "",
      attendeeName: meta.attendeeName || "", // NEW
      itemId: meta.itemId || "",
    };
  });

  const order = {
    id: s.id,
    created: Date.now(),
    payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || "",
    charge: null,
    currency: s.currency || "usd",
    amount_total: cents(s.amount_total || 0),
    customer_email: s.customer_details?.email || "",
    purchaser: {
      name: s.customer_details?.name || "",
      phone: s.customer_details?.phone || "",
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
  await kvSaddSafe("orders:index", order.id);
  return order;
}

async function applyRefundToOrder(chargeId, refund) {
  const ids = await kvGetSafe("orders:index", []);
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

function flattenOrderToRows(o) {
  const rows = [];
  (o.lines || []).forEach(li => {
    const net = li.gross;
    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "",
      category: li.category || 'other',
      item: li.itemName || '',
      qty: li.qty || 1,
      price: (li.unitPrice || 0) / 100,
      gross: (li.gross || 0) / 100,
      fees: 0,
      net: (net || 0) / 100,
      status: o.status || "paid",
      notes: "",
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id
    });
  });
  const feeLine = (o.lines || []).find(li => /processing fee/i.test(li.itemName || ""));
  if (feeLine) {
    rows.push({
      id: o.id, date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "", category: 'other',
      item: feeLine.itemName || 'Processing Fee',
      qty: feeLine.qty || 1,
      price: (feeLine.unitPrice || 0) / 100,
      gross: (feeLine.gross || 0) / 100,
      fees: 0, net: (feeLine.gross || 0) / 100,
      status: o.status || "paid",
      notes: "", _pi: o.payment_intent || "", _charge: o.charge || "", _session: o.id
    });
  }
  return rows;
}

// -------- Email rendering + sending (group by attendee; no logo) --------
function absoluteUrl(path = "/") {
  const base = (process.env.SITE_BASE_URL || "").replace(/\/+$/,"");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Grouped, logo-free renderer
function renderOrderEmailHTML(order) {
  const money = (c) => (Number(c||0)/100).toLocaleString("en-US",{style:"currency",currency:"USD"});

  // Group lines by attendeeName (fallback attendeeId, then "Unassigned")
  const groups = {};
  for (const li of (order.lines || [])) {
    const keyName = (li.attendeeName || "").trim();
    const keyId   = (li.attendeeId || "").trim();
    const key = keyName || keyId || "Unassigned";
    if (!groups[key]) groups[key] = { name: keyName || (key === "Unassigned" ? "Unassigned" : keyId), id: keyId, items: [] };
    groups[key].items.push(li);
  }

  const groupBlocks = Object.values(groups).map(g => {
    const rows = g.items.map(li => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee">
          <div style="font-weight:600">${li.itemName || ""}</div>
          ${li.notes ? `<div style="color:#374151;font-size:12px;white-space:pre-wrap">${String(li.notes)}</div>` : ""}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${li.qty || 1}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(li.unitPrice)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(li.gross)}</td>
      </tr>
    `).join("");

    const groupTotal = g.items.reduce((s,li)=> s + (li.gross||0), 0);

    return `
      <div style="margin-top:16px">
        <div style="font-weight:700;margin:8px 0">
          Attendee: ${g.name}${g.id && g.name !== g.id ? ` <span style="color:#6b7280;font-size:12px">(${g.id})</span>` : ""}
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Item</th>
              <th style="text-align:center;padding:8px;border-bottom:1px solid #ddd">Qty</th>
              <th style="text-align:right;padding:8px;border-bottom:1px solid #ddd">Price</th>
              <th style="text-align:right;padding:8px;border-bottom:1px solid #ddd">Line</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="text-align:right;padding:10px;border-top:2px solid #ddd;font-weight:700">Attendee Subtotal</td>
              <td style="text-align:right;padding:10px;border-top:2px solid #ddd;font-weight:700">${money(groupTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }).join("");

  const subtotal = (order.lines||[]).reduce((s,li)=>s+(li.gross||0),0);
  const total = order.amount_total || subtotal;

  return `<!doctype html><html>
  <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;color:#111;margin:0">
    <div style="max-width:720px;margin:0 auto;padding:16px 20px">
      <div style="margin-bottom:6px;font-size:18px;font-weight:800">Grand Court of PA — Order of the Amaranth</div>
      <div style="font-size:13px;color:#555;margin-bottom:12px">Order #${order.id}</div>

      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-top:8px">
        <div style="font-weight:700;margin-bottom:6px">Purchaser</div>
        <div>${order.purchaser?.name || "—"}</div>
        <div>${order.customer_email || "—"}</div>
        <div>${order.purchaser?.phone || "—"}</div>
        <div style="color:#6b7280;font-size:12px;margin-top:6px">
          Date: ${new Date(order.created||Date.now()).toLocaleString()} · Currency: ${(order.currency||"USD").toUpperCase()} · Status: ${order.status || "paid"}
        </div>
      </div>

      ${groupBlocks || ""}

      <div style="margin-top:16px;border-top:2px solid #ddd;padding-top:12px;font-weight:700;display:flex;justify-content:flex-end">
        <div style="min-width:220px;display:flex;justify-content:space-between">
          <span>Total</span>
          <span>${money(total)}</span>
        </div>
      </div>

      <p style="color:#6b7280;font-size:12px;margin-top:12px">
        Thank you for your order! If you have questions, just reply to this email.
      </p>
    </div>
  </body></html>`;
}

// Single-email flow: To purchaser (or first admin if no purchaser) + BCC admins (identical content)
async function sendOrderReceipts(order) {
  if (!resend) return { sent: false, reason: "resend-not-configured" };

  const purchaserEmail = (order.customer_email || "").trim().toLowerCase();
  const adminList = (
    process.env.REPORTS_BCC || process.env.REPORTS_CC || ""
  ).split(",").map(s=>s.trim()).filter(Boolean);

  let to = [];
  if (purchaserEmail) to = [purchaserEmail];
  else if (adminList.length) to = [adminList[0]];

  if (!to.length && adminList.length === 0) return { sent: false, reason: "no-recipients" };

  const bcc = adminList.filter(e => e.toLowerCase() !== (to[0] || "").toLowerCase());
  const subject = `Grand Court of PA - Order #${order.id}`;
  const html = renderOrderEmailHTML(order);

  await resend.emails.send({
    from: process.env.RESEND_FROM,
    to,
    bcc: bcc.length ? bcc : undefined,
    subject,
    html
  });

  return { sent: true };
}

// -------------- main handler --------------
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
          kvSetGetOk: false,
        };
        try { await kv.set("smoketest:key", "ok", { ex: 30 }); } catch (e) {}
        try {
          const v = await kv.get("smoketest:key");
          out.kvSetGetOk = (v === "ok");
        } catch (e) { out.kvError = String(e?.message || e); }
        return REQ_OK(res, out);
      }

      if (type === "banquets")  return REQ_OK(res, { banquets: (await kvGetSafe("banquets")) || [] });
      if (type === "addons")    return REQ_OK(res, { addons: (await kvGetSafe("addons")) || [] });
      if (type === "products")  return REQ_OK(res, { products: (await kvGetSafe("products")) || [] });

      if (type === "settings") {
        const overrides = await kvHgetallSafe("settings:overrides");
        const env = {
          RESEND_FROM: process.env.RESEND_FROM || "",
          REPORTS_CC: process.env.REPORTS_CC || "",
          REPORTS_BCC: process.env.REPORTS_BCC || "",
          SITE_BASE_URL: process.env.SITE_BASE_URL || "",
          MAINTENANCE_ON: process.env.MAINTENANCE_ON === "true",
          MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || ""
        };
        const effective = { ...env, ...overrides,
          MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true"
        };
        return REQ_OK(res, { env, overrides, effective });
      }

      // Publishable key (supports both names for safety)
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

      if (type === "orders") {
        const ids = await kvGetSafe("orders:index", []);
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
        }
        return REQ_OK(res, { rows: all });
      }

      return REQ_ERR(res, 400, "unknown-type");
    }

    // ---------- POST ----------
    if (req.method === "POST") {
      const body = req.body || {};

      if (action === "create_checkout_session") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");

        const origin = req.headers.origin || `https://${req.headers.host}`;
        // Redirect to /success.html now
        const successUrl = (body.success_url || `${origin}/success.html`) + `?sid={CHECKOUT_SESSION_ID}`;
        const cancelUrl  = body.cancel_url  || `${origin}/order.html`;

        if (Array.isArray(body.lines) && body.lines.length) {
          const lines = body.lines;
          const fees = body.fees || { pct: 0, flat: 0 };
          const purchaser = body.purchaser || {};

          // --- REPLACED: pass attendeeName + notes into Stripe metadata ---
          const line_items = lines.map(l => ({
            quantity: Math.max(1, Number(l.qty || 1)),
            price_data: {
              currency: "usd",
              unit_amount: toCentsAuto(l.unitPrice || 0),
              product_data: {
                name: String(l.itemName || "Item"),
                metadata: {
                  itemId: l.itemId || "",
                  itemType: l.itemType || "",
                  attendeeId: l.attendeeId || "",
                  attendeeName: l.attendeeName || "", // NEW
                  notes: l.notes || ""                 // NEW
                }
              }
            }
          }));

          const pct       = Number(fees.pct || 0);
          const flatCents = toCentsAuto(fees.flat || 0);
          const subtotalCents = lines.reduce((s,l)=> s + toCentsAuto(l.unitPrice || 0) * Number(l.qty || 0), 0);
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

          const session = await stripe.checkout.sessions.create({
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
          });

          return REQ_OK(res, { url: session.url, id: session.id });
        }

        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) return REQ_ERR(res, 400, "no-items");

        const session = await stripe.checkout.sessions.create({
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
        });
        return REQ_OK(res, { url: session.url, id: session.id });
      }

      // Stripe webhook
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
            event = typeof req.body === "string" ? JSON.parse(req.body) : req.body; // dev fallback
          }
        } catch (err) {
          console.error("Webhook signature verification failed:", err?.message);
          return REQ_ERR(res, 400, "invalid-signature");
        }

        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const order = await saveOrderFromSession(session);

            // Fire-and-forget email — never block webhook
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
          default: break;
        }
        return REQ_OK(res, { received: true });
      }

      // --- PUBLIC: register an item config (used by pages calling AMARANTH_REGISTER_ENDPOINT) ---
      if (action === "register_item") {
        const { id = "", name = "", chairEmails = [], publishStart = "", publishEnd = "" } = body || {};
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

      // -------- ADMIN (auth) --------
      if (!requireToken(req, res)) return;

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
        ["RESEND_FROM","REPORTS_CC","REPORTS_BCC","SITE_BASE_URL","MAINTENANCE_ON","MAINTENANCE_MESSAGE"]
          .forEach(k => { if (k in body) allow[k] = body[k]; });
        if ("MAINTENANCE_ON" in allow) allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
        if (Object.keys(allow).length) await kvHsetSafe("settings:overrides", allow);
        return REQ_OK(res, { ok: true, overrides: allow });
      }

      return REQ_ERR(res, 400, "unknown-action");
    }

    return REQ_ERR(res, 405, "method-not-allowed");
  } catch (e) {
    console.error(e);
    return REQ_ERR(res, 500, "router-failed", { message: e?.message || String(e) });
  }
}

// Vercel Node 22 runtime
export const config = { runtime: "nodejs" };
