import crypto from "crypto";

const RATE_WINDOW_SECONDS = 10 * 60;
const RATE_MAX_ATTEMPTS = 5;
export const TEST_EMAIL_AUDIT_KEY = "audit:test_email";

function splitAllowlist(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function bearerFingerprint(req) {
  const auth = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return token
    ? crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16)
    : "unknown";
}

function clientKey(req) {
  const raw = req?.headers?.["x-forwarded-for"] || req?.headers?.["x-real-ip"] || "unknown";
  return crypto.createHash("sha256").update(String(raw).split(",")[0].trim()).digest("hex").slice(0, 16);
}

export async function authorizeTestEmail({ req, res, body, requireAdminAuth, kv, env = process.env }) {
  if (typeof requireAdminAuth !== "function" || !(await requireAdminAuth(req, res))) {
    return { ok: false, handled: true };
  }

  if (String(env.TEST_EMAIL_ENABLED || "true").trim().toLowerCase() === "false") {
    res.status(503).json({ error: "test-email-disabled" });
    return { ok: false, handled: true };
  }

  const allowlist = splitAllowlist(env.TEST_EMAIL_ALLOWLIST);
  const recipient = String(body?.to || "").trim().toLowerCase();
  if (!recipient || !allowlist.includes(recipient)) {
    res.status(403).json({ error: "recipient-not-allowed" });
    return { ok: false, handled: true };
  }

  const admin = bearerFingerprint(req);
  const rateKey = `rate:test_email:${admin}:${clientKey(req)}`;
  const count = await kv.incr(rateKey);
  if (count === 1) await kv.expire(rateKey, RATE_WINDOW_SECONDS);
  if (count > RATE_MAX_ATTEMPTS) {
    res.status(429).json({ error: "rate-limit-exceeded", retryAfter: RATE_WINDOW_SECONDS });
    return { ok: false, handled: true };
  }

  return { ok: true, recipient, admin, rateKey };
}

export async function recordTestEmailAudit({ kv, admin, recipient, status, resultId = null }) {
  const entry = {
    date: new Date().toISOString(),
    administrator: admin,
    recipient,
    action: "test_email",
    status,
    resultId,
  };
  await kv.lpush(TEST_EMAIL_AUDIT_KEY, entry);
  await kv.ltrim(TEST_EMAIL_AUDIT_KEY, 0, 499);
  return entry;
}

export async function sendApprovedTestEmail({ resend, payload }) {
  return resend.emails.send(payload);
}
