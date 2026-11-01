import crypto from "crypto";

export const MANUAL_ORDER_AUDIT_KEY = "audit:manual_orders";
export const MANUAL_PAYMENT_METHODS = new Set([
  "check", "cash", "mail", "complimentary", "external_card", "offline_card",
  "invoice", "pending", "paypal", "other",
]);

const FORBIDDEN_STRIPE_FIELDS = new Set([
  "payment_intent", "paymentintent", "paymentintentid", "checkout_session",
  "checkoutsession", "checkoutsessionid", "session_id", "sessionid", "charge",
  "chargeid", "stripeverified", "webhookstatus", "refundstatus", "refunds",
]);

function normalizedKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function findForbiddenStripeField(value, path = "body") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_STRIPE_FIELDS.has(normalizedKey(key))) return `${path}.${key}`;
    const nested = findForbiddenStripeField(child, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

export async function authorizeManualMutation({ req, res, requireAdminAuth }) {
  if (typeof requireAdminAuth !== "function" || !(await requireAdminAuth(req, res))) {
    return false;
  }
  return true;
}

export function normalizeManualPaymentMethod(value) {
  const method = String(value || "check").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (method === "stripe" || method === "card") throw new Error("stripe-payment-not-allowed");
  if (!MANUAL_PAYMENT_METHODS.has(method)) throw new Error("invalid-manual-payment-method");
  return method;
}

export function generateManualOrderId(prefix = "manual") {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}_${ts}_${crypto.randomBytes(8).toString("hex")}`;
}

export async function createManualOrderOnly({ kv, order, maxAttempts = 5 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const id = attempt === 0 && order.id ? order.id : generateManualOrderId(order.idPrefix || "manual");
    const next = { ...order, id };
    delete next.idPrefix;
    const result = await kv.set(`order:${id}`, next, { nx: true });
    if (result === "OK" || result === true) return next;
  }
  throw new Error("manual-order-id-collision");
}

export async function recordManualOrderAudit({ kv, action, order, administrator }) {
  const entry = {
    date: new Date().toISOString(),
    action,
    orderId: order.id,
    administrator: String(administrator || "Admin"),
    source: "admin-manual",
    stripeVerified: false,
  };
  await kv.lpush(MANUAL_ORDER_AUDIT_KEY, entry);
  await kv.ltrim(MANUAL_ORDER_AUDIT_KEY, 0, 999);
  return entry;
}
