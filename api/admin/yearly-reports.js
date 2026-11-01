// /api/admin/yearly-reports.js
//
// Provides Year-over-Year helpers used by /api/router.js:
//
// import {
//   listIndexedYears,
//   getYearSummary,
//   getMultiYearSummary,
// } from "./admin/yearly-reports.js";
//
// This implementation is "safe by default":
// - Works even if you do NOT have prebuilt KV year indexes.
// - Scans orders:index and computes summaries from stored orders.
// - Never throws for missing/odd order shapes; it skips bad records.
//
// Expected output fields (router maps these):
//   { year, totalOrders, uniqueBuyers, repeatBuyers, totalPeople, totalCents, ... }
//
// NOTE: If later you want this faster, we can add KV indexing keys like:
//   orders:years:index (set of years)
//   orders:years:<year>:orders (set of order ids)
//   orders:years:<year>:buyers (set of buyer emails)
// etc.

import { kvGetSafe, kvSmembersSafe, flattenOrderToRows } from "./core.js";

// ------------------------- helpers -------------------------

function safeLower(s) {
  return String(s || "").trim().toLowerCase();
}

function inferYearFromOrder(order) {
  // Prefer explicit ISO timestamps if present
  const candidates = [
    order?.createdAt,
    order?.created_at,
    order?.date,
    order?.timestamp,
  ];

  for (const c of candidates) {
    const t = String(c || "").trim();
    if (!t) continue;
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return new Date(ms).getUTCFullYear();
  }

  // If order.createdAt stored as ms number
  const n = Number(order?.createdAtMs || order?.created_at_ms || NaN);
  if (Number.isFinite(n)) return new Date(n).getUTCFullYear();

  return null;
}

function pickBuyerKey(order) {
  // Try email first; then name+phone as fallback (still stable-ish)
  const email =
    order?.purchaserEmail ||
    order?.buyerEmail ||
    order?.email ||
    order?.customer_email ||
    order?.customerEmail ||
    order?.purchaser?.email;

  const e = safeLower(email);
  if (e) return e;

  const name =
    order?.purchaserName ||
    order?.buyerName ||
    order?.purchaser ||
    order?.customer_name ||
    order?.customerName;

  const phone = order?.purchaserPhone || order?.phone || order?.customer_phone;

  const n = String(name || "").trim();
  const p = String(phone || "").trim();
  const key = safeLower(`${n}|${p}`);
  return key || ""; // may still be blank
}

function pickPeopleCount(order) {
  // Best effort:
  // - If order has attendees array use its length
  // - Else: use flattened rows and count unique attendee names
  const at = order?.attendees;
  if (Array.isArray(at) && at.length) return at.length;

  try {
    const rows = flattenOrderToRows(order) || [];
    const seen = new Set();
    for (const r of rows) {
      const a = String(r?.attendee || "").trim();
      if (a) seen.add(a.toLowerCase());
    }
    if (seen.size) return seen.size;
  } catch {}

  // fallback: 1 person per order if we have nothing else
  return 1;
}

function pickOrderTotalCents(order) {
  // Try common totals; fallback to summing flattened rows 'gross' if present
  const candidates = [
    order?.totalCents,
    order?.total_cents,
    order?.amount_total,
    order?.amountTotal,
    order?.total,
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      // If "total" looks like dollars (e.g., 55.00), convert if needed
      if (n < 1000 && String(c).includes(".")) return Math.round(n * 100);
      // If it's already cents (typical), use as-is
      return Math.round(n);
    }
  }

  // Sum from rows if possible
  try {
    const rows = flattenOrderToRows(order) || [];
    let sum = 0;
    for (const r of rows) {
      // Your rows often have gross in dollars or cents depending on your core.
      // We treat:
      //  - if gross >= 1000 assume cents
      //  - else assume dollars
      const g = Number(r?.gross ?? r?.amount ?? 0);
      if (!Number.isFinite(g) || g <= 0) continue;
      sum += g >= 1000 ? Math.round(g) : Math.round(g * 100);
    }
    return sum > 0 ? sum : 0;
  } catch {}

  return 0;
}

async function loadAllOrdersSafe() {
  const ids = (await kvSmembersSafe("orders:index")) || [];
  const orders = [];

  for (const id of ids) {
    const sid = String(id || "").trim();
    if (!sid) continue;

    const o = await kvGetSafe(`order:${sid}`, null);
    if (o && typeof o === "object") orders.push(o);
  }

  return orders;
}

function computeSummaryForYearFromOrders(year, orders) {
  const y = Number(year);
  const buyerCounts = new Map();
  let totalOrders = 0;
  let totalPeople = 0;
  let totalCents = 0;

  for (const o of orders) {
    const oy = inferYearFromOrder(o);
    if (oy !== y) continue;

    totalOrders += 1;

    const buyerKey = pickBuyerKey(o);
    if (buyerKey) buyerCounts.set(buyerKey, (buyerCounts.get(buyerKey) || 0) + 1);

    totalPeople += pickPeopleCount(o);
    totalCents += pickOrderTotalCents(o);
  }

  const uniqueBuyers = buyerCounts.size;
  let repeatBuyers = 0;
  for (const c of buyerCounts.values()) if (c > 1) repeatBuyers += 1;

  return {
    ok: true,
    year: y,
    totalOrders,
    uniqueBuyers,
    repeatBuyers,
    totalPeople,
    totalCents,
  };
}

// ------------------------- public API -------------------------

export async function listIndexedYears() {
  const orders = await loadAllOrdersSafe();
  const years = new Set();

  for (const o of orders) {
    const y = inferYearFromOrder(o);
    if (Number.isFinite(y)) years.add(y);
  }

  return Array.from(years).sort((a, b) => a - b);
}

export async function getYearSummary(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) {
    return { ok: false, error: "invalid-year", year };
  }

  const orders = await loadAllOrdersSafe();
  return computeSummaryForYearFromOrders(y, orders);
}

export async function getMultiYearSummary(years) {
  const list = Array.isArray(years) ? years : [];
  const want = list
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!want.length) return [];

  const orders = await loadAllOrdersSafe();

  // Compute each year from the same in-memory list (1 scan of KV)
  return want.map((y) => computeSummaryForYearFromOrders(y, orders));
}
