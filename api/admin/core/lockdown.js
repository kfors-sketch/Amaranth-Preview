import crypto from "crypto";

import { getEffectiveSettings } from "./env.js";

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

// Cached orders for the lifetime of a single lambda invocation

export { tokenFingerprint, getLockdownConfig, assertNotLocked };
