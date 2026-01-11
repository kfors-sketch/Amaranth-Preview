// /api/admin/report-channel.js

import { kvGetSafe, kvSetSafe } from "./core.js";

// One KV doc that controls BOTH report channel + receipt zip frequency.
// Keep it simple and auditable.
export const REPORTING_PREFS_KEY = "admin:reporting:prefs";

/**
 * channel: which order channel to pull from when building chair reports + receipt zips
 *   - "auto" (default): resolve to "live" in production, otherwise "test"
 *   - "test"
 *   - "live_test"
 *   - "live"
 *
 * receiptZip:
 *   - monthly: boolean
 *   - weekly: boolean
 */
export function normalizeChannel(input) {
  const v = String(input || "").trim().toLowerCase();
  if (v === "test" || v === "live_test" || v === "live" || v === "auto") return v;
  return "auto";
}

export function normalizeZipPrefs(input) {
  // Default: monthly ON, weekly OFF
  const monthly =
    input && typeof input.monthly === "boolean" ? input.monthly : true;
  const weekly =
    input && typeof input.weekly === "boolean" ? input.weekly : false;
  return { monthly: !!monthly, weekly: !!weekly };
}

export async function getReportingPrefs() {
  const raw = (await kvGetSafe(REPORTING_PREFS_KEY)) || {};
  const channel = normalizeChannel(raw.channel);
  const receiptZip = normalizeZipPrefs(raw.receiptZip);
  return { channel, receiptZip };
}

export async function setReportingPrefs(next) {
  const current = await getReportingPrefs();
  const merged = {
    ...current,
    ...(next || {}),
    channel: normalizeChannel(next?.channel ?? current.channel),
    receiptZip: normalizeZipPrefs(next?.receiptZip ?? current.receiptZip),
  };
  await kvSetSafe(REPORTING_PREFS_KEY, merged);
  return merged;
}

/**
 * If you already have “order channels” in your system (test/live_test/live),
 * you likely have a function like getEffectiveSettings() or env controls.
 *
 * This helper resolves the channel to use at runtime.
 */
export function resolveChannel({ requested, isProduction }) {
  const channel = normalizeChannel(requested);
  if (channel === "test" || channel === "live_test" || channel === "live") return channel;

  // auto:
  // - production => live
  // - otherwise => test
  return isProduction ? "live" : "test";
}

export function shouldSendReceiptZip({ prefs, kind }) {
  // kind: "weekly" | "monthly"
  const p = prefs?.receiptZip || { monthly: false, weekly: false };
  if (kind === "weekly") return !!p.weekly;
  if (kind === "monthly") return !!p.monthly;
  return false;
}
