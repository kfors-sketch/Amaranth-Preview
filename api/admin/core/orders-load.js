import { kvGetSafe, kvSmembersSafe } from "./kv.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _ordersCache = null;

// When admin tools patch stored orders, the warm lambda may still hold a cached
// copy. Expose a small helper so router.js can clear it after a patch.
export function clearOrdersCache() {
  _ordersCache = null;
}

// Load all orders with a few retries to be safer on cold starts
async function loadAllOrdersWithRetry(options = {}) {
  const { retries = 4, delayMs = 500 } = options;
  if (Array.isArray(_ordersCache)) return _ordersCache;

  let lastOrders = [];

  for (let attempt = 0; attempt < retries; attempt++) {
    const idx = await kvSmembersSafe("orders:index");
    const orders = [];
    for (const sid of idx) {
      const o = await kvGetSafe(`order:${sid}`, null);
      if (o) orders.push(o);
    }
    lastOrders = orders;

    if (orders.length > 0 || idx.length === 0) {
      _ordersCache = orders;
      return orders;
    }

    if (attempt < retries - 1) await sleep(delayMs);
  }

  _ordersCache = lastOrders;
  return lastOrders;
}


export { loadAllOrdersWithRetry };
