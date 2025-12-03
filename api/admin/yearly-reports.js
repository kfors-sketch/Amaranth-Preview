// /api/admin/yearly-reports.js
import { kv } from "@vercel/kv";
import { parseDateISO } from "../router-helpers.js"; // optional if you want

/**
 * Save an order into the yearly index
 * Called from saveOrderFromSession()
 */
export async function indexOrderByYear(orderId, createdAt) {
  try {
    const dt = createdAt ? new Date(createdAt) : new Date();
    const year = dt.getFullYear();
    await kv.sadd(`orders:years:${year}`, orderId);
  } catch (err) {
    console.error("indexOrderByYear error:", err);
  }
}

/**
 * Load all order IDs for a year
 */
export async function loadOrderIdsForYear(year) {
  const key = `orders:years:${year}`;
  const ids = await kv.smembers(key);
  return Array.isArray(ids) ? ids : [];
}

/**
 * Load the full order objects for a given year
 */
export async function loadOrdersForYear(year) {
  const ids = await loadOrderIdsForYear(year);
  const orders = [];

  for (const id of ids) {
    const o = await kv.hgetall(`order:${id}`);
    if (o) {
      o._id = id;
      orders.push(o);
    }
  }
  return orders;
}

/**
 * Compute yearly stats:
 *  - total orders
 *  - unique buyers
 *  - buyer frequency map
 */
export function computeYearlyStats(orders) {
  const freq = {};
  let totalOrders = orders.length;

  for (const o of orders) {
    const email = String(o.email || "").trim().toLowerCase();
    if (!email) continue;
    freq[email] = (freq[email] || 0) + 1;
  }

  const uniqueBuyers = Object.keys(freq).length;

  return {
    totalOrders,
    uniqueBuyers,
    repeatBuyers: totalOrders - uniqueBuyers,
    frequencyByEmail: freq,
  };
}

/**
 * Full summary for a given year
 */
export async function getYearSummary(year) {
  const orders = await loadOrdersForYear(year);
  const stats = computeYearlyStats(orders);

  return {
    year,
    totalOrders: stats.totalOrders,
    uniqueBuyers: stats.uniqueBuyers,
    repeatBuyers: stats.repeatBuyers,
    frequencyByEmail: stats.frequencyByEmail,
    orders, // optional: include full data for export
  };
}