import { kvGetSafe, kvSetSafe } from "./kv.js";
import { resend, RESEND_FROM, REPLY_TO } from "./env.js";
import { sendWithRetry } from "./retry.js";
import { renderOrderEmailHTML } from "./receipts-render.js";

const REALTIME_CHAIR_KEY_PREFIX = "order:catalog_chairs_sent:";

async function sendRealtimeChairEmailsForOrder(order) {
  if (!order || !Array.isArray(order.lines)) return { sent: 0 };
  const seen = new Set();
  let sent = 0;

  for (const li of order.lines) {
    const cat = String(li.category || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();
    const isCatalog = cat === "catalog" || metaType === "catalog";
    if (!isCatalog) continue;

    const id = String(li.itemId || "").trim();
    if (!id) continue;

    const key = `${cat}:${baseKey(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = li.itemName || id;

    const result = await sendItemReportEmailInternal({
      kind: cat || "catalog",
      id,
      label,
      scope: "full",
    });

    if (result.ok) sent += 1;
  }

  return { sent };
}

async function maybeSendRealtimeChairEmails(order) {
  if (!order?.id) return;
  const key = `${REALTIME_CHAIR_KEY_PREFIX}${order.id}`;
  const already = await kvGetSafe(key, null);
  if (already) return;

  try {
    await sendRealtimeChairEmailsForOrder(order);
    await kvSetSafe(key, new Date().toISOString());
  } catch (e) {
    console.error("realtime-chair-email-failed", e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Monthly / final receipts ZIP helpers (simple + safe; used by exports)
// ---------------------------------------------------------------------------

function monthIdUTC(ms) {
  const d = new Date(Number(ms || Date.now()));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}


// ✅ Week id in UTC, ISO-like (YYYY-Www). Week starts Monday (UTC).
function weekKeyUTC(ms) {
  const d = new Date(ms);
  // Convert so Monday=0..Sunday=6
  const day = (d.getUTCDay() + 6) % 7;
  // Thursday of this week decides the ISO year
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const isoYear = thursday.getUTCFullYear();

  // Week 1 is the week with Jan 4th
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(Date.UTC(isoYear, 0, 4 - jan4Day));

  const diffDays = Math.floor((thursday.getTime() - week1Mon.getTime()) / 86400000);
  const week = Math.floor(diffDays / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function weekRangeUTC(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  const end = start + 7 * 86400000;
  return { startMs: start, endMs: end };
}

// ✅ Weekly receipts ZIP idempotency key (per week + per mode)
function weeklyReceiptsZipSentKey(mode, weekKey) {
  const m = String(mode || "test").toLowerCase();
  const wk = String(weekKey || "").trim();
  return `receiptszip:weekly:${m}:${wk}`;
}

// ✅ Monthly receipts ZIP idempotency key (per month + per mode)
function monthlyReceiptsZipSentKey(mode, month) {
  const m = String(mode || "test").toLowerCase();
  const mm = String(month || "").trim();
  return `receiptszip:monthly:${m}:${mm}`;
}


export {
  REALTIME_CHAIR_KEY_PREFIX,
  sendRealtimeChairEmailsForOrder,
  maybeSendRealtimeChairEmails,
};
