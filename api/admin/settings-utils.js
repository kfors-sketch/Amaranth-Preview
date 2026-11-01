// /api/admin/settings-utils.js
import crypto from "crypto";
import { kvHgetallSafe } from "./kv-utils.js";

const RESEND_FROM = (process.env.RESEND_FROM || "").trim();
const REPLY_TO = (process.env.REPLY_TO || process.env.REPORTS_REPLY_TO || "").trim();

// ---------------------------------------------------------------------------
// LOCKDOWN MODE (block write actions during live/event week)
// ---------------------------------------------------------------------------

function getClientIp(req) {
  const xf = req?.headers?.["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  const real = req?.headers?.["x-real-ip"];
  if (real) return String(real).trim();
  return (req?.socket?.remoteAddress || "").trim();
}

function tokenFingerprint(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 6);
}

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
    EVENT_START: process.env.EVENT_START || "",
    EVENT_END: process.env.EVENT_END || "",
    REPORT_ORDER_DAYS: process.env.REPORT_ORDER_DAYS || "",
    LOCKDOWN_MODE: process.env.LOCKDOWN_MODE || "off",
    LOCKDOWN_ALLOW_IPS: process.env.LOCKDOWN_ALLOW_IPS || "",
    LOCKDOWN_ALLOW_TOKEN_FPS: process.env.LOCKDOWN_ALLOW_TOKEN_FPS || "",
  };
  const effective = {
    ...env,
    ...overrides,
    MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true",
  };
  return { env, overrides, effective };
}

async function getLockdownConfig() {
  const { effective } = await getEffectiveSettings();

  const modeRaw = String(effective.LOCKDOWN_MODE || process.env.LOCKDOWN_MODE || "off")
    .trim()
    .toLowerCase();
  const mode = ["off", "admin", "all"].includes(modeRaw) ? modeRaw : "off";

  const allowIps = String(effective.LOCKDOWN_ALLOW_IPS || process.env.LOCKDOWN_ALLOW_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowTokenFps = String(
    effective.LOCKDOWN_ALLOW_TOKEN_FPS || process.env.LOCKDOWN_ALLOW_TOKEN_FPS || ""
  )
    .split(",")
    .map((s) => s.trim())
    .toLowerCase()
    .filter(Boolean);

  return { mode, allowIps, allowTokenFps };
}

async function lockdownAllowsBypass(req) {
  const { allowIps, allowTokenFps } = await getLockdownConfig();

  const ip = getClientIp(req);
  if (ip && allowIps.includes(ip)) return { ok: true, reason: "ip-allow" };

  const token =
    req?.headers?.["x-amaranth-admin-token"] || req?.headers?.["x-admin-token"] || "";
  const fp = tokenFingerprint(token);
  if (fp && allowTokenFps.includes(fp.toLowerCase())) return { ok: true, reason: "token-allow", fp };

  return { ok: false, reason: "not-allowed" };
}

// Call this from router BEFORE performing a write action.
// action: "admin-write" | "checkout-write"
async function assertNotLocked(req, action = "admin-write") {
  const { mode } = await getLockdownConfig();
  if (!mode || mode === "off") return;

  const blocksAdmin = mode === "admin" || mode === "all";
  const blocksCheckout = mode === "all";
  const shouldBlock =
    (action === "admin-write" && blocksAdmin) || (action === "checkout-write" && blocksCheckout);
  if (!shouldBlock) return;

  const bypass = await lockdownAllowsBypass(req);
  if (bypass.ok) return;

  const err = new Error(`LOCKDOWN: ${action} blocked`);
  err.code = "lockdown";
  throw err;
}


export {
  getClientIp,
  tokenFingerprint,
  getEffectiveSettings,
  getLockdownConfig,
  lockdownAllowsBypass,
  assertNotLocked,
};
