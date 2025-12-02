// /api/admin/security.js
//
// High-security admin helpers:
// - Server-side password check using process.env.ADMIN_PASSWORD
// - Token issuance + TTL in KV
// - Token verification for protected routes
// - Failed-attempt tracking + simple rate limiting
// - IP lockouts
// - Optional security alert emails via Resend

import crypto from "crypto";
import {
  kv,
  resend,
  RESEND_FROM,
  REPORTS_LOG_TO,
  CONTACT_TO,
} from "./core.js";

// --- Tunable security settings ---

// How long an admin token stays valid (in seconds)
const ADMIN_TOKEN_TTL_SEC = 12 * 60 * 60; // 12 hours

// Rate limiting window and thresholds
const ADMIN_LOGIN_WINDOW_SEC = 10 * 60; // 10 minutes
const ADMIN_MAX_FAILS_PER_WINDOW = 5;   // lock IP after this many failures in window

// Lockout duration after too many failures
const ADMIN_LOCKOUT_SEC = 30 * 60; // 30 minutes

// Alert threshold: if we see this many failures (globally) in the alert window
const ADMIN_ALERT_FAIL_THRESHOLD = 10;
const ADMIN_ALERT_WINDOW_SEC = 10 * 60; // 10 minutes

// Where to send security alerts (fallbacks if a dedicated env isn't set)
const SECURITY_ALERT_TO =
  (process.env.SECURITY_ALERT_TO || "").trim() ||
  REPORTS_LOG_TO ||
  CONTACT_TO ||
  "";

// --- Small utilities ---

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizeIP(ip) {
  if (!ip) return "unknown";
  // trim any long X-Forwarded-For chain to just first entry
  return String(ip).split(",")[0].trim() || "unknown";
}

function generateAdminToken() {
  // Example: adm_<64 hex chars>
  return "adm_" + crypto.randomBytes(32).toString("hex");
}

// --- KV key helpers ---

function failKey(ip) {
  return `admin:login:fail:${ip}`;
}

function lockKey(ip) {
  return `admin:login:lock:${ip}`;
}

function tokenKey(token) {
  return `admin:token:${token}`;
}

const ALERT_KEY = "admin:login:fail:recent";

// --- Core helpers ---

/**
 * Check if an IP is currently locked out of login attempts.
 */
export async function isIPLocked(ip) {
  const key = lockKey(ip);
  const v = await kv.get(key);
  return !!v;
}

/**
 * Lock an IP for a fixed period.
 */
export async function lockIP(ip) {
  const key = lockKey(ip);
  await kv.set(key, "1", { ex: ADMIN_LOCKOUT_SEC });
}

/**
 * Record a failed login attempt for an IP, enforce simple rate limiting,
 * and optionally trigger alert logic.
 *
 * Returns an object:
 *   { locked: boolean, failCount: number }
 */
export async function recordFailedAttempt(ip, userAgent = "") {
  const ipKey = failKey(ip);

  // Increment per-IP failure counter and set expiry so it auto-resets.
  let count = await kv.incr(ipKey);
  if (count === 1) {
    // first failure in this window; set expiration for the window length
    await kv.expire(ipKey, ADMIN_LOGIN_WINDOW_SEC);
  }

  // If failures exceed the threshold, lock the IP
  if (count >= ADMIN_MAX_FAILS_PER_WINDOW) {
    await lockIP(ip);
  }

  // Also track a global rolling count to detect broader attack patterns
  let globalCount = await kv.incr(ALERT_KEY);
  if (globalCount === 1) {
    await kv.expire(ALERT_KEY, ADMIN_ALERT_WINDOW_SEC);
  }

  // If we cross alert threshold, try sending an email
  if (globalCount >= ADMIN_ALERT_FAIL_THRESHOLD) {
    await sendSecurityAlert({
      reason: "multiple_failed_admin_logins",
      ip,
      userAgent,
      failCount: globalCount,
    });
    // Let the TTL handle reset; no need to manually reset the counter
  }

  return { locked: count >= ADMIN_MAX_FAILS_PER_WINDOW, failCount: count };
}

/**
 * Issue an admin token and store it in KV with TTL.
 * Returns the token string.
 */
export async function issueAdminToken(ip, userAgent = "") {
  const token = generateAdminToken();
  const key = tokenKey(token);
  const payload = {
    createdAt: nowUnix(),
    ip,
    userAgent,
  };
  await kv.set(key, payload, { ex: ADMIN_TOKEN_TTL_SEC });
  return token;
}

/**
 * Verify an admin token from an Authorization: Bearer header.
 * Returns either:
 *   { ok: true, context } or { ok: false, error }
 */
export async function verifyAdminToken(token) {
  if (!token || typeof token !== "string") {
    return { ok: false, error: "missing_token" };
  }
  const key = tokenKey(token);
  const data = await kv.get(key);
  if (!data) {
    return { ok: false, error: "invalid_or_expired_token" };
  }
  return { ok: true, context: data };
}

/**
 * Convenience helper to extract and verify the admin token from a request-like object.
 * You can call this from router.js with your Request / headers.
 */
export async function requireAdminFromHeaders(headers) {
  const auth = headers.get
    ? headers.get("authorization") || headers.get("Authorization")
    : headers["authorization"] || headers["Authorization"];

  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "missing_authorization_header" };
  }
  const token = auth.slice(7).trim();
  return verifyAdminToken(token);
}

/**
 * Main login handler logic (backend side). This does NOT deal with HTTP directly;
 * router.js should pass in { password, ip, userAgent } and send the result back
 * to the client.
 *
 * Returns an object safe to JSON.stringify, for example:
 *   { ok: true, token }
 *   { ok: false, error: "locked_out", retryAfter: seconds }
 *   { ok: false, error: "invalid_password" }
 */
export async function handleAdminLogin({ password, ip, userAgent }) {
  const safeIP = normalizeIP(ip);
  const pwEnv = (process.env.ADMIN_PASSWORD || "").trim();

  if (!pwEnv) {
    // Misconfiguration – no server-side password set
    return { ok: false, error: "server_not_configured" };
  }

  // If this IP is locked, deny immediately
  if (await isIPLocked(safeIP)) {
    return {
      ok: false,
      error: "locked_out",
      // client can optionally use this to show a message like "Try again later"
      retryAfter: ADMIN_LOCKOUT_SEC,
    };
  }

  // Compare password (case-sensitive)
  if (!password || password !== pwEnv) {
    const { locked } = await recordFailedAttempt(safeIP, userAgent);
    if (locked) {
      return {
        ok: false,
        error: "locked_out",
        retryAfter: ADMIN_LOCKOUT_SEC,
      };
    }
    return { ok: false, error: "invalid_password" };
  }

  // Successful login — issue token and (optionally) clear failure counters
  const token = await issueAdminToken(safeIP, userAgent);

  // We could clear failKey(safeIP) here if desired, but the expiry will clean it up anyway.

  return { ok: true, token, ttlSeconds: ADMIN_TOKEN_TTL_SEC };
}

/**
 * Optional security alert email. Uses Resend via core.js if available.
 */
export async function sendSecurityAlert(info) {
  try {
    if (!resend || !RESEND_FROM || !SECURITY_ALERT_TO) return;

    const subject = "Amaranth Admin: Security Alert";
    const { reason, ip, userAgent, failCount } = info || {};

    const lines = [
      "Security event detected on Amaranth admin login.",
      "",
      `Reason: ${reason || "unknown"}`,
      `IP: ${ip || "unknown"}`,
      `User-Agent: ${userAgent || "unknown"}`,
      typeof failCount === "number" ? `Recent failed attempts: ${failCount}` : "",
      "",
      `Time (server): ${new Date().toISOString()}`,
    ].filter(Boolean);

    await resend.emails.send({
      from: RESEND_FROM,
      to: SECURITY_ALERT_TO,
      subject,
      text: lines.join("\n"),
    });
  } catch (err) {
    // We never want alert failures to break login logic
    console.error("Failed to send security alert:", err);
  }
}