// /api/admin/lockdown-utils.js
import { kvGetSafe, REQ_ERR } from "./core.js";

const LOCKDOWN_KEY = "security:lockdown";

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !!v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    ""
  );
}

function ipMatchesAllowlist(ip, allowlist) {
  const raw = String(ip || "").trim();
  if (!raw) return false;

  const first = raw.split(",")[0].trim();

  for (const a of allowlist) {
    const aa = String(a || "").trim();
    if (!aa) continue;
    if (first === aa) return true;
    if (aa.endsWith("*") && first.startsWith(aa.slice(0, -1))) return true;
  }
  return false;
}

export async function getLockdownStateSafe() {
  const raw = await kvGetSafe(LOCKDOWN_KEY, null);

  if (typeof raw === "boolean") {
    return { on: raw, message: raw ? "Lockdown is enabled." : "", updatedAt: "" };
  }

  if (raw && typeof raw === "object") {
    const on = coerceBool(raw.on ?? raw.enabled ?? raw.locked ?? false);
    const message = String(raw.message || raw.note || "").trim();
    const updatedAt = String(raw.updatedAt || "").trim();
    return { on, message, updatedAt };
  }

  const envOn = coerceBool(process.env.LOCKDOWN_ON || "");
  return {
    on: envOn,
    message: envOn ? "Lockdown is enabled (env)." : "",
    updatedAt: "",
  };
}

export async function isLockdownBypassed(req) {
  const allowIps = splitCsv(process.env.LOCKDOWN_BYPASS_IPS || "");
  if (!allowIps.length) return false;
  return ipMatchesAllowlist(getClientIp(req), allowIps);
}

function isWriteAction(action) {
  return [
    "save_feature_flags",
    "purge_orders",
    "save_banquets",
    "save_addons",
    "save_tours",
    "save_products",
    "save_catalog_items",
    "save_settings",
    "save_checkout_mode",
    "clear_orders",
    "create_refund",
    "mark_manual_refund",
    "unmark_manual_refund",
    "send_full_report",
    "send_month_to_date",
    "send_monthly_chair_reports",
    "send_end_of_event_reports",
    "send_item_report",
    "register_item",
  ].includes(String(action || ""));
}

export async function enforceLockdownIfNeeded(req, res, action, requestId) {
  const st = await getLockdownStateSafe();
  if (!st.on) return true;
  if (await isLockdownBypassed(req)) return true;
  if (!isWriteAction(action)) return true;

  return !REQ_ERR(res, 423, "lockdown", {
    requestId,
    message:
      st.message ||
      "Site is in lockdown mode. Admin write actions are temporarily disabled.",
    updatedAt: st.updatedAt || "",
    action,
  });
}
