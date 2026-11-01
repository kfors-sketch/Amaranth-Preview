import crypto from "node:crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function text(value, max) {
  const out = String(value ?? "").trim();
  return out.length <= max ? out : null;
}

export function validEmail(value) {
  const email = text(value, 254);
  return email && EMAIL_RE.test(email) ? email.toLowerCase() : null;
}

export function hasBotTrap(body) {
  return Boolean(String(body?.website || body?.company || body?.fax || "").trim());
}

export function validateContactInput(body) {
  if (!body || typeof body !== "object" || JSON.stringify(body).length > 16_384) return { error: "invalid-body" };
  if (hasBotTrap(body)) return { error: "bot-detected" };
  const value = {
    name: text(body.name, 120), email: validEmail(body.email), phone: text(body.phone, 40),
    topic: text(body.topic, 60), page: text(body.page, 80), item: text(body.item, 200),
    message: text(body.message, 4_000),
  };
  if (!value.name || !value.email || !value.topic || !value.message) return { error: "invalid-fields" };
  if (Object.values(value).some((v) => v === null)) return { error: "invalid-fields" };
  return { value };
}

export function validateSuppliesInput(body) {
  if (!body || typeof body !== "object" || JSON.stringify(body).length > 16_384) return { error: "invalid-body" };
  if (hasBotTrap(body)) return { error: "bot-detected" };
  const value = {
    item: { id: text(body.item?.id, 100), name: text(body.item?.name, 200), category: text(body.item?.category, 100) },
    purchaser: { name: text(body.purchaser?.name, 120), email: validEmail(body.purchaser?.email), phone: text(body.purchaser?.phone, 40), courtName: text(body.purchaser?.courtName, 160), courtNumber: text(body.purchaser?.courtNumber, 40) },
    notes: text(body.notes, 2_000),
  };
  if (Object.values(value.item).some((v) => !v) || Object.values(value.purchaser).some((v) => !v) || value.notes === null) return { error: "invalid-fields" };
  return { value };
}

export function clientRateKey(req, form) {
  const raw = String(req?.headers?.["x-forwarded-for"] || req?.headers?.["x-real-ip"] || req?.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `rate:public-form:${form}:${digest}:${Math.floor(Date.now() / 600_000)}`;
}

export async function enforcePublicFormRateLimit(store, req, form, max = 5) {
  if (!store || typeof store.incr !== "function") return { ok: false, unavailable: true };
  const key = clientRateKey(req, form);
  try {
    const count = await store.incr(key);
    if (count === 1 && typeof store.expire === "function") await store.expire(key, 610);
    return { ok: count <= max, count };
  } catch {
    return { ok: false, unavailable: true };
  }
}
