// /api/admin/yearly-reports.js
import { kv } from "@vercel/kv";

// Key helpers
const YEAR_SET_KEY = (year) => `orders:years:${year}`;
const YEAR_INDEX_KEY = "orders:years:index";

/**
 * Save an order into the yearly index
 * Called from saveOrderFromSession(orderId, createdAt)
 */
export async function indexOrderByYear(orderId, createdAt) {
  try {
    const dt = createdAt ? new Date(createdAt) : new Date();
    const year = dt.getFullYear();

    // Track which orders belong to this year
    await kv.sadd(YEAR_SET_KEY(year), orderId);

    // Track that this year exists at all (for dropdowns / lists)
    await kv.sadd(YEAR_INDEX_KEY, String(year));
  } catch (err) {
    console.error("indexOrderByYear error:", err);
  }
}

/**
 * Return a sorted list of all years that have been indexed.
 * Useful for building dropdowns / ranges in reporting_main.html.
 */
export async function listIndexedYears() {
  try {
    const raw = await kv.smembers(YEAR_INDEX_KEY);
    const years = Array.isArray(raw) ? raw : [];

    return years
      .map((y) => Number(y))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  } catch (err) {
    console.error("listIndexedYears error:", err);
    return [];
  }
}

/**
 * Load all order IDs for a year
 */
export async function loadOrderIdsForYear(year) {
  const key = YEAR_SET_KEY(year);
  const ids = await kv.smembers(key);
  return Array.isArray(ids) ? ids : [];
}

/**
 * Load the full order objects for a given year
 * Assumes each order is stored under `order:${id}` as a hash/object.
 */
export async function loadOrdersForYear(year) {
  const ids = await loadOrderIdsForYear(year);
  const orders = [];

  for (const id of ids) {
    try {
      const o = await kv.hgetall(`order:${id}`);
      if (o) {
        o._id = id;
        orders.push(o);
      }
    } catch (err) {
      console.error(`loadOrdersForYear: failed to load order ${id}`, err);
    }
  }

  return orders;
}

/**
 * Compute yearly stats:
 *  - total orders
 *  - unique buyers (by email)
 *  - repeat buyers
 *  - total people (if orders carry attendee info)
 *  - total cents (sum of order totals, best-effort)
 *  - frequency map by email
 *
 * This is intentionally generic so it works with your current order shape.
 * If you normalize your order structure later, you can tighten this up.
 */
export function computeYearlyStats(orders) {
  const freq = {};
  const totalOrders = orders.length;
  let totalPeople = 0;
  let totalCents = 0;

  for (const o of orders) {
    // Prefer billingEmail if present, else fallback to email.
    const email = String(
      o.billingEmail || o.email || o.purchaserEmail || ""
    )
      .trim()
      .toLowerCase();

    if (email) {
      freq[email] = (freq[email] || 0) + 1;
    }

    // Try to approximate "people" from attendees if your orders store them
    // Adjust if your schema differs.
    if (Array.isArray(o.attendees)) {
      totalPeople += o.attendees.length;
    } else if (o.attendeeCount != null) {
      const n = Number(o.attendeeCount);
      if (Number.isFinite(n) && n > 0) {
        totalPeople += n;
      }
    }

    // Best-effort total cents; adjust field names to match your order schema.
    const centsCandidate = Number(
      o.totalCents ??
        o.amountCents ??
        o.grandTotalCents ??
        o.stripeTotalCents ??
        0
    );
    if (Number.isFinite(centsCandidate)) {
      totalCents += centsCandidate;
    }
  }

  const uniqueBuyers = Object.keys(freq).length;
  const repeatBuyers = Math.max(0, totalOrders - uniqueBuyers);

  return {
    totalOrders,
    uniqueBuyers,
    repeatBuyers,
    totalPeople,
    totalCents,
    frequencyByEmail: freq,
  };
}

/**
 * Full summary for a given year
 * Includes:
 *  - core stats (orders, buyers, people, cents)
 *  - frequencyByEmail for deeper purchaser analysis
 *  - orders array (so you can export if you want)
 */
export async function getYearSummary(year) {
  const orders = await loadOrdersForYear(year);
  const stats = computeYearlyStats(orders);

  return {
    year,
    totalOrders: stats.totalOrders,
    uniqueBuyers: stats.uniqueBuyers,
    repeatBuyers: stats.repeatBuyers,
    totalPeople: stats.totalPeople,
    totalCents: stats.totalCents,
    frequencyByEmail: stats.frequencyByEmail,
    orders, // keep the raw orders for export/advanced use
  };
}

/**
 * Convenience: get summaries for multiple years at once.
 * e.g. getMultiYearSummary([2024, 2025, 2026])
 * Perfect for graphs and pick-your-years comparisons.
 */
export async function getMultiYearSummary(years) {
  const out = [];
  for (const y of years || []) {
    const yr = Number(y);
    if (!Number.isFinite(yr)) continue;
    out.push(await getYearSummary(yr));
  }
  return out;
}