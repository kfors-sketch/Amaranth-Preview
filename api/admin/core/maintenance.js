import { kvDelSafe, kvHsetSafe } from "./kv.js";
import { loadAllOrdersWithRetry, clearOrdersCache } from "./orders-load.js";

// Purge orders by mode (with safe LIVE guard)
// ---------------------------------------------------------------------------

const ALLOW_LIVE_PURGE = String(process.env.ALLOW_LIVE_PURGE || "false") === "true";

function resolveOrderKey(order) {
  return `order:${String(order?.id || "").trim()}`;
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


export { purgeOrdersByMode };
