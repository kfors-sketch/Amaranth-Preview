// /api/admin/core.js
import {
  getStripe,
  getStripePublishableKey,
  getCheckoutSettingsRaw,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
} from "./stripe-mode.js";
import {
  kv,
  cents,
  dollarsToCents,
  toCentsAuto,
  kvGetSafe,
  kvHsetSafe,
  kvSaddSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvSmembersSafe,
  kvDelSafe,
} from "./kv-utils.js";
import { verifyOrderHash } from "./order-hash.js";
import {
  tokenFingerprint,
  getEffectiveSettings,
  getLockdownConfig,
  assertNotLocked,
} from "./settings-utils.js";
import {
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,
  EMAIL_RECEIPTS,
  sendWithRetry,
  MAIL_LOG_KEY,
  recordMailLog,
} from "./mail-utils.js";
import { buildCSV, buildCSVSelected, objectsToXlsxBuffer } from "./export-utils.js";
import {
  parseDateISO,
  parseYMD,
  sortByDateAsc,
  baseKey,
  normalizeKey,
  normalizeReportFrequency,
  filterRowsByWindow,
  applyItemFilters,
} from "./report-utils.js";
import {
  computeStripeProcessingFeeFromLines,
  absoluteUrl,
  renderOrderEmailHTML,
  sendReceiptXlsxBackup,
  sendOrderReceipts,
} from "./receipt-utils.js";
import {
  loadAllOrdersWithRetry,
  fetchSessionAndItems,
  saveOrderFromSession,
  applyRefundToOrder,
  flattenOrderToRows,
  collectAttendeesFromOrders,
} from "./order-utils.js";
import {
  emailWeeklyReceiptsZip,
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,
} from "./receipts-zip-utils.js";
import {
  getChairEmailsForItemId,
  sendItemReportEmailInternal,
  REALTIME_CHAIR_KEY_PREFIX,
  sendRealtimeChairEmailsForOrder,
  maybeSendRealtimeChairEmails,
} from "./chair-report-utils.js";

const REQ_OK = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });

// ---------------------------------------------------------------------------
// Purge orders by mode (with safe LIVE guard)
// ---------------------------------------------------------------------------

const ALLOW_LIVE_PURGE = String(process.env.ALLOW_LIVE_PURGE || "false") === "true";

function resolveOrderKey(order) {
  return `order:${String(order?.id || "").trim()}`;
}

async function clearOrdersCache() {
  return { ok: true, skipped: true };
}

async function patchOrderCourtFields(orderId, fields = {}) {
  const id = String(orderId || "").trim();
  if (!id) throw new Error("missing-order-id");

  const key = `order:${id}`;
  const existing = (await kvHgetallSafe(key)) || {};
  const patch = {
    ...(fields || {}),
    updatedAt: new Date().toISOString(),
    adminPatchedAt: new Date().toISOString(),
  };

  await kvHsetSafe(key, patch);
  return { ok: true, id, order: { ...existing, ...patch } };
}

async function rehashOrderAfterAdminPatch(orderId) {
  const id = String(orderId || "").trim();
  if (!id) throw new Error("missing-order-id");

  await kvSetSafe(`order:${id}:rehashRequestedAt`, new Date().toISOString());
  return { ok: true, id, rehashSkipped: true };
}

/**
 * Purge orders by mode.
 * mode: "test" | "live_test" | "live"
 * options: { hard?: boolean }
 *
 * NOTE: any order with no `mode` is treated as "test".
 */
async function purgeOrdersByMode(mode, { hard = false } = {}) {
  if (!["test", "live_test", "live"].includes(mode)) {
    throw new Error(`Invalid mode for purge: ${mode}`);
  }

  if (mode === "live" && (hard || !ALLOW_LIVE_PURGE)) {
    throw new Error("Hard purge of LIVE data is disabled for safety.");
  }

  const all = await loadAllOrdersWithRetry();
  const target = all.filter((o) => String(o.mode || "test").toLowerCase() === mode);

  let count = 0;

  for (const order of target) {
    const key = resolveOrderKey(order);

    if (mode === "live" || !hard) {
      await kvHsetSafe(key, {
        deleted: true,
        deletedAt: new Date().toISOString(),
        deletedReason: `purge-${mode}`,
      });
    } else {
      await kvDelSafe(key);
    }
    count++;
  }

  return { count, mode, hard: mode === "live" ? false : hard };
}

// ------------- EXPORTS -------------
// prettier-ignore
export {
  kv,

  getStripe,
  getStripePublishableKey,
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,

  EMAIL_RECEIPTS,
  sendReceiptXlsxBackup,
  emailWeeklyReceiptsZip,
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,

  verifyOrderHash,
  assertNotLocked,
  getLockdownConfig,
  tokenFingerprint,

  REQ_OK,
  REQ_ERR,
  cents,
  dollarsToCents,
  toCentsAuto,
  kvGetSafe,
  kvHsetSafe,
  kvSaddSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvSmembersSafe,
  kvDelSafe,
  sendWithRetry,
  loadAllOrdersWithRetry,
  parseDateISO,
  parseYMD,
  sortByDateAsc,
  baseKey,
  normalizeKey,
  normalizeReportFrequency,
  getEffectiveSettings,
  filterRowsByWindow,
  applyItemFilters,
  MAIL_LOG_KEY,
  recordMailLog,
  fetchSessionAndItems,
  getChairEmailsForItemId,
  saveOrderFromSession,
  applyRefundToOrder,
  flattenOrderToRows,
  computeStripeProcessingFeeFromLines,
  absoluteUrl,
  renderOrderEmailHTML,
  sendOrderReceipts,
  buildCSV,
  buildCSVSelected,
  objectsToXlsxBuffer,
  collectAttendeesFromOrders,
  sendItemReportEmailInternal,
  REALTIME_CHAIR_KEY_PREFIX,
  sendRealtimeChairEmailsForOrder,
  maybeSendRealtimeChairEmails,

  getCheckoutSettingsRaw,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
  purgeOrdersByMode,
  clearOrdersCache,
  patchOrderCourtFields,
  rehashOrderAfterAdminPatch,
};
