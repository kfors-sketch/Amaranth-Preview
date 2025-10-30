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
function dataUrlToParts(dataUrlOrBase64, mimeFromClient = "") {
  if (!dataUrlOrBase64) return null;
  const s = String(dataUrlOrBase64);
  if (s.startsWith("data:")) {
    const m = s.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return null;
    return { mime: m[1] || (mimeFromClient || "application/octet-stream"), base64: m[2] };
  }
  return { mime: mimeFromClient || "application/octet-stream", base64: s };
}

function cents(n) { return Math.round(Number(n || 0)); }
function dollarsToCents(n) { return Math.round(Number(n || 0) * 100); }

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

async function kvGetSafe(key, fallback = null) { try { return await kv.get(key); } catch { return fallback; } }
async function kvHsetSafe(key, obj)          { try { await kv.hset(key, obj); return true; } catch { return false; } }
async function kvSaddSafe(key, val)          { try { await kv.sadd(key, val); return true; } catch { return false; } }
async function kvSetSafe(key, val)           { try { await kv.set(key, val);  return true; } catch { return false; } }
async function kvHgetallSafe(key)            { try { return (await kv.hgetall(key)) || {}; } catch { return {}; } }

// ----- order persistence helpers -----
async function saveOrderFromSession(session) {
  const stripe = await getStripe();
  if (!stripe) throw new Error("stripe-not-configured");

  // Expand line items if not present
  const s = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items.data.price.product", "payment_intent"],
  });

  const lines = (s.line_items?.data || []).map(li => {
    const name  = li.description || li.price?.product?.name || "Item";
    const qty   = Number(li.quantity || 1);
    const unit  = cents(li.price?.unit_amount || 0);
    const total = unit * qty;

    // metadata we put into product_data.metadata in create_checkout_session (new cart path)
    const meta = (li.price?.product?.metadata || {});
    return {
      id: `${s.id}:${li.id}`,
      itemName: name,
      qty,
      unitPrice: unit,
      gross: total,
      category: (meta.itemType || '').toLowerCase() || 'other',
      notes: "",
      attendeeId: meta.attendeeId || "",
      itemId: meta.itemId || "",
    };
  });

  const order = {
    id: s.id,
    created: Date.now(),
    payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || "",
    charge: null, // can be filled by subsequent webhook or PI expand
    currency: s.currency || "usd",
    amount_total: cents(s.amount_total || 0),
    customer_email: s.customer_details?.email || "",
    purchaser: {
      name: s.customer_details?.name || "",
      phone: s.customer_details?.phone || "",
    },
    lines,
    fees: { pct: 0, flat: 0 }, // already baked into a dedicated fee line if you used it
    refunds: [],               // [{id, amount, charge, created}]
    refunded_cents: 0,
    status: "paid"
  };

  // Try to get charge id from payment intent (if expanded)
  const piId = order.payment_intent;
  if (piId) {
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["charges.data"] }).catch(()=>null);
    if (pi?.charges?.data?.length) {
      order.charge = pi.charges.data[0].id;
    }
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

      if (o.refunded_cents >= o.amount_total) {
        o.status = "refunded";
      } else {
        o.status = "partial_refund";
      }
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
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "",
      category: 'other',
      item: feeLine.itemName || 'Processing Fee',
      qty: feeLine.qty || 1,
      price: (feeLine.unitPrice || 0) / 100,
      gross: (feeLine.gross || 0) / 100,
      fees: 0,
      net: (feeLine.gross || 0) / 100,
      status: o.status || "paid",
      notes: "",
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id
    });
  }

  return rows;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get("action");
    const type  = url.searchParams.get("type");

    // ---------- READS ----------
    if (req.method === "GET") {

      // --- Diagnostics: smoketest ---
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

        // Actively test KV read/write (not just method presence)
        try {
          await kv.set("smoketest:key", "ok", { ex: 30 });
          const v = await kv.get("smoketest:key");
          out.kvSetGetOk = (v === "ok");
        } catch (e) {
          out.kvError = String(e?.message || e);
        }

        return REQ_OK(res, out);
      }

      // --- Diagnostics: echo ---
      if (type === "echo") {
        return REQ_OK(res, {
          method: req.method,
          contentType: req.headers["content-type"] || "",
          typeofBody: typeof req.body,
          rawBodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : null
        });
      }

      if (type === "banquets") {
        const banquets = (await kvGetSafe("banquets")) || [];
        return REQ_OK(res, { banquets });
      }
      if (type === "addons") {
        const addons = (await kvGetSafe("addons")) || [];
        return REQ_OK(res, { addons });
      }
      if (type === "products") {
        const products = (await kvGetSafe("products")) || [];
        return REQ_OK(res, { products });
      }
      if (type === "settings") {
        const overrides = await kvHgetallSafe("settings:overrides");
        const env = {
          RESEND_FROM: process.env.RESEND_FROM || "",
          REPORTS_CC: process.env.REPORTS_CC || "",
          MAINTENANCE_ON: process.env.MAINTENANCE_ON === "true",
          MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || ""
        };
        const effective = { ...env, ...overrides,
          MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true"
        };
        return REQ_OK(res, { env, overrides, effective });
      }
      if (type === "send-test") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured");
        const to = url.searchParams.get("to") || process.env.REPORTS_CC || "";
        if (!to) return REQ_ERR(res, 400, "missing-to");
        await resend.emails.send({
          from: process.env.RESEND_FROM,
          to,
          subject: "Amaranth Reports — Test",
          text: "This is a test email to confirm deliverability."
        });
        return REQ_OK(res, { ok: true });
      }
      if (type === "product_image") {
        const id = url.searchParams.get("id") || "";
        const slot = url.searchParams.get("slot") || "image1";
        if (!id) return REQ_ERR(res, 400, "missing-id");
        const key = `productimg:${id}:${slot}`;
        const stored = await kvGetSafe(key, null);
        if (!stored || !stored.base64) return REQ_ERR(res, 404, "not-found");
        const buf = Buffer.from(stored.base64, "base64");
        res.setHeader("Content-Type", stored.mime || "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.status(200).send(buf);
      }
      if (type === "stripe_pubkey") {
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
      // NEW: orders feed for reporting
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

    // ---------- WRITES ----------
    if (req.method === "POST") {
      const body = req.body || {};

      // PUBLIC: Create Stripe Checkout Session
      if (action === "create_checkout_session") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");

        const origin = req.headers.origin || `https://${req.headers.host}`;
        const successUrl = (body.successUrl || `${origin}/success.html`) + `?sid={CHECKOUT_SESSION_ID}`;
        const cancelUrl  = body.cancelUrl  || `${origin}/cancel.html`;

        let line_items = [];

        if (Array.isArray(body.lines) && body.lines.length) {
          const lines = body.lines;
          const fees = body.fees || { pct: 0, flat: 0 };
          const purchaser = body.purchaser || {};

          line_items = lines.map(l => ({
            quantity: Math.max(1, Number(l.qty || 1)),
            price_data: {
              currency: "usd",
              unit_amount: cents(l.unitPrice || 0),
              product_data: {
                name: String(l.itemName || "Item"),
                metadata: {
                  itemId: l.itemId || "",
                  itemType: l.itemType || "",
                  attendeeId: l.attendeeId || ""
                }
              }
            }
          }));

          const pct  = Number(fees.pct || 0);
          const flat = cents(fees.flat || 0);
          const subtotal = lines.reduce((s, l) => s + cents(l.unitPrice||0) * Number(l.qty||0), 0);
          const feeAmount = Math.max(0, Math.round(subtotal * (pct/100)) + flat);
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

        line_items = items.map(it => ({
          quantity: Math.max(1, Number(it.quantity || 1)),
          price_data: {
            currency: "usd",
            unit_amount: dollarsToCents(it.price || 0),
            product_data: {
              name: String(it.name || "Item"),
              images: it.imageUrl ? [it.imageUrl] : undefined,
            },
          },
        }));

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          line_items,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
        });

        return REQ_OK(res, { url: session.url, id: session.id });
      }

      // STRIPE WEBHOOK (point your Stripe endpoint to: /api/router?action=stripe_webhook)
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
            // fallback (test mode) – trust parsed JSON
            event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
          }
        } catch (err) {
          console.error("Webhook signature verification failed:", err?.message);
          return REQ_ERR(res, 400, "invalid-signature");
        }

        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            await saveOrderFromSession(session);
            break;
          }
          case "charge.refunded": {
            const refund = event.data.object;
            const chargeId = refund.charge;
            await applyRefundToOrder(chargeId, refund);
            break;
          }
          default:
            break;
        }

        return REQ_OK(res, { received: true });
      }

      // ADMIN-ONLY from here down
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
        ["RESEND_FROM","REPORTS_CC","MAINTENANCE_ON","MAINTENANCE_MESSAGE"]
          .forEach(k => { if (k in body) allow[k] = body[k]; });
        if ("MAINTENANCE_ON" in allow) allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
        if (Object.keys(allow).length) await kvHsetSafe("settings:overrides", allow);
        return REQ_OK(res, { ok: true, overrides: allow });
      }
      if (action === "register_item") {
        const { id, name, chairEmails = [], publishStart = "", publishEnd = "" } = body;
        if (!id || !name) return REQ_ERR(res, 400, "id-and-name-required");
        const cfg = {
          id, name,
          chairEmails: (Array.isArray(chairEmails) ? chairEmails : []).filter(Boolean),
          publishStart, publishEnd,
          updatedAt: new Date().toISOString()
        };
        const ok1 = await kvHsetSafe(`itemcfg:${id}`, cfg);
        const ok2 = await kvSaddSafe("itemcfg:index", id);
        if (!ok1 || !ok2) {
          return REQ_OK(res, { ok: true, warning: "kv-unavailable" });
        }
        return REQ_OK(res, { ok: true });
      }
      if (action === "upload_product_image") {
        const { id = "", slot = "image1", dataUrl = "", fileBase64 = "", mime = "" } = body || {};
        if (!id) return REQ_ERR(res, 400, "missing-id");
        const parts = dataUrlToParts(dataUrl || fileBase64, mime);
        if (!parts || !parts.base64) return REQ_ERR(res, 400, "missing-image");
        const key = `productimg:${id}:${slot}`;
        const saved = await kvSetSafe(key, {
          mime: parts.mime,
          base64: parts.base64,
          updatedAt: new Date().toISOString()
        });
        if (!saved) return REQ_OK(res, { ok: false, warning: "kv-unavailable" });
        const urlOut = `/api/router?type=product_image&id=${encodeURIComponent(id)}&slot=${encodeURIComponent(slot)}`;
        return REQ_OK(res, { ok: true, url: urlOut });
      }
      if (action === "send_report") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured");
        const { to = [], subject = "Amaranth Report", csv = "" } = body;
        if (!to.length) return REQ_ERR(res, 400, "missing-recipients");
        const attachment = [{
          filename: "report.csv",
          content: Buffer.from(csv).toString("base64"),
          encoding: "base64"
        }];
        await resend.emails.send({
          from: process.env.RESEND_FROM,
          to,
          cc: (process.env.REPORTS_CC || "").split(",").map(s=>s.trim()).filter(Boolean),
          subject,
          text: "Attached is your report.",
          attachments: attachment
        });
        return REQ_OK(res, { ok: true });
      }

      // Admin refunds (full or partial)
      if (action === "create_refund") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");
        const { payment_intent, charge, amount_cents } = body || {};
        if (!payment_intent && !charge) return REQ_ERR(res, 400, "missing-payment_intent-or-charge");
        const params = {
          ...(payment_intent ? { payment_intent } : { charge }),
          ...(Number.isFinite(amount_cents) ? { amount: Number(amount_cents) } : {})
        };
        const refund = await stripe.refunds.create(params);
        return REQ_OK(res, { ok: true, refund });
      }

      return REQ_ERR(res, 400, "unknown-action");
    }

    return REQ_ERR(res, 405, "method-not-allowed");
  } catch (e) {
    console.error(e);
    return REQ_ERR(res, 500, "router-failed", { message: e?.message || String(e) });
  }
}

// 👇 Node 22 runtime hint for Vercel
export const config = { runtime: "nodejs" };
