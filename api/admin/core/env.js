import { Resend } from "resend";
import { kvHgetallSafe } from "./kv.js";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ---- Mail “From / Reply-To” ----
const RESEND_FROM = (process.env.RESEND_FROM || "").trim();
const REPLY_TO = (process.env.REPLY_TO || process.env.REPORTS_REPLY_TO || "").trim();
const REPORTS_LOG_TO = (process.env.REPORTS_LOG_TO || "").trim();
const CONTACT_TO = (process.env.CONTACT_TO || process.env.EMAIL_CONTACT || "").trim();

// Backup receipts inbox (XLSX copy of each receipt)
const EMAIL_RECEIPTS = (process.env.EMAIL_RECEIPTS || "").trim();

const REQ_OK = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });

// ---------- helpers ----------
function cents(n) {
  return Math.round(Number(n || 0));
}
function dollarsToCents(n) {
  return Math.round(Number(n || 0) * 100);
}
function toCentsAuto(v) {
  const n = Number(v || 0);
  return n < 1000 ? Math.round(n * 100) : Math.round(n);
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

export {
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,
  EMAIL_RECEIPTS,
  REQ_OK,
  REQ_ERR,
  cents,
  dollarsToCents,
  toCentsAuto,
  getEffectiveSettings,
};
