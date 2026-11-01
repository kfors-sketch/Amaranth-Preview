// /api/admin/mail-utils.js
import { Resend } from "resend";
import { kv } from "./kv-utils.js";

// ============================================================================
// REPORT EMAIL STAGGERING (scheduled_at)
// ============================================================================
let _REPORT_STAGGER = {
  baseMs: 0,
  idx: 0,
  lastTouchedMs: 0,
};

export function nextReportScheduledAtIso({ allow, hasYahoo, explicitIso }) {
  if (!allow || !hasYahoo) return "";
  if (explicitIso) return explicitIso;

  const now = Date.now();
  if (!_REPORT_STAGGER.baseMs || now - (_REPORT_STAGGER.lastTouchedMs || 0) > 5 * 60_000) {
    _REPORT_STAGGER.baseMs = now;
    _REPORT_STAGGER.idx = 0;
  }
  _REPORT_STAGGER.lastTouchedMs = now;

  const idx = _REPORT_STAGGER.idx++;
  if (idx <= 0) return "";

  const t = _REPORT_STAGGER.baseMs + idx * 60_000;
  if (t <= now + 30_000) return "";
  return new Date(t).toISOString();
}

export const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export const RESEND_FROM = (process.env.RESEND_FROM || "").trim();
export const REPLY_TO = (process.env.REPLY_TO || process.env.REPORTS_REPLY_TO || "").trim();
export const REPORTS_LOG_TO = (process.env.REPORTS_LOG_TO || "").trim();
export const CONTACT_TO = (process.env.CONTACT_TO || process.env.EMAIL_CONTACT || "").trim();
export const EMAIL_RECEIPTS = (process.env.EMAIL_RECEIPTS || "").trim();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendWithRetry(sendFn, label = "email") {
  const attempts = [0, 2000, 5000, 10000];
  let lastErr = null;

  for (let i = 1; i <= 3; i++) {
    try {
      if (attempts[i] > 0) await sleep(attempts[i]);
      const result = await sendFn();
      return { ok: true, attempt: i, result };
    } catch (err) {
      lastErr = err;
      console.error(`Retry ${i} failed for ${label}:`, err);
    }
  }

  return { ok: false, error: lastErr };
}

export const MAIL_LOG_KEY = "mail:lastlog";
const MAIL_LOG_LIST_KEY = "mail:logs";

export async function recordMailLog(payload) {
  try {
    await kv.set(MAIL_LOG_KEY, payload, { ex: 3600 });
  } catch {}

  try {
    await kv.lpush(MAIL_LOG_LIST_KEY, payload);
    await kv.ltrim(MAIL_LOG_LIST_KEY, 0, 199);
  } catch {}
}
