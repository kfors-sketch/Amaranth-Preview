// /api/admin/report-channel.js

import { kv } from "@vercel/kv";

// Standalone KV helpers (do NOT import core.js here; keep this file isolated)
async function kvGetSafe(key) {
  try {
    return await kv.get(key);
  } catch (e) {
    console.error("[report-channel] kv.get failed", { key, error: e?.message || String(e) });
    return null;
  }
}

async function kvSetSafe(key, value) {
  try {
    await kv.set(key, value);
    return true;
  } catch (e) {
    console.error("[report-channel] kv.set failed", { key, error: e?.message || String(e) });
    return false;
  }
}

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
  const monthly = !!(input && input.monthly);
  const weekly = !!(input && input.weekly);
  return { monthly, weekly };
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
