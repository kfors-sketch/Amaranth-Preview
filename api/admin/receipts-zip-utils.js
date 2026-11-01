// /api/admin/receipts-zip-utils.js
import JSZip from "jszip";
import { resend, RESEND_FROM, REPLY_TO, EMAIL_RECEIPTS, sendWithRetry } from "./mail-utils.js";
import { kvGetSafe, kvSetSafe } from "./kv-utils.js";
import { loadAllOrdersWithRetry } from "./order-utils.js";
import { renderOrderEmailHTML, RECEIPT_XLSX_HEADERS, RECEIPT_XLSX_HEADER_LABELS, buildReceiptXlsxRows } from "./receipt-utils.js";
import { objectsToXlsxBuffer } from "./export-utils.js";

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

async function emailWeeklyReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();
  const _now = Date.now();
  // Weekly ZIP should cover the *previous completed* Mon→Sun week (UTC),
  // since the cron runs Monday morning.
  const _prevWeekNow = _now - 7 * 24 * 60 * 60 * 1000;
  const weekKey = weekKeyUTC(_prevWeekNow);
  const { startMs, endMs } = weekRangeUTC(_prevWeekNow);

  // ✅ LIVE/LIVE_TEST: only send once per month (even if cron runs daily)
  // TEST: allowed to send repeatedly (useful while testing)
  const enforceMonthlyOnce = wantMode === "live" || wantMode === "live_test";
  const sentKey = weeklyReceiptsZipSentKey(wantMode, weekKey);

  if (enforceMonthlyOnce) {
    const already = await kvGetSafe(sentKey, null);
    if (already) {
      return { ok: true, skipped: true, month: weekKey, mode: wantMode, reason: "already-sent" };
    }
  }

  const rows = [];
  const zip = new JSZip();

  for (const o of orders) {
    const om = String(o.mode || "test").toLowerCase();
    if (om !== wantMode) continue;
    if (o.created < startMs || o.created >= endMs) continue;

    const html = renderOrderEmailHTML(o);
    zip.file(`receipt-${wantMode}-${o.id}.html`, html);

    rows.push(...buildReceiptXlsxRows(o));
  }

  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipts"
  );
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  zip.file(`receipts-${wantMode}-${weekKey}.xlsx`, xlsxBuf);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const zipB64 = Buffer.from(zipBuf).toString("base64");

  if (!RESEND_FROM) throw new Error("RESEND_FROM missing");
const from = RESEND_FROM;
  const subject = `Weekly Receipts ZIP — ${weekKey} (${wantMode})`;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">Attached: receipts ZIP for <b>${weekKey}</b> (${wantMode}).</div>`,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipts-${wantMode}-${weekKey}.zip`,
        content: zipB64,
        content_type: "application/zip",
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipts-zip-weekly:${wantMode}:${weekKey}`
  );

  if (retry.ok) {
    // ✅ Mark as sent (LIVE/LIVE_TEST only) so daily cron won't re-send
    if (enforceMonthlyOnce) {
      await kvSetSafe(sentKey, {
        sentAt: new Date().toISOString(),
        month: weekKey,
        mode: wantMode,
        subject,
      });
    }

    return { ok: true, month: weekKey, mode: wantMode };
  }

  return { ok: false, error: retry.error?.message || String(retry.error) };
}



async function emailMonthlyReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();
  const nowMonth = monthIdUTC(Date.now());

  // ✅ LIVE/LIVE_TEST: only send once per month (even if cron runs daily)
  // TEST: allowed to send repeatedly (useful while testing)
  const enforceMonthlyOnce = wantMode === "live" || wantMode === "live_test";
  const sentKey = monthlyReceiptsZipSentKey(wantMode, nowMonth);

  if (enforceMonthlyOnce) {
    const already = await kvGetSafe(sentKey, null);
    if (already) {
      return { ok: true, skipped: true, month: nowMonth, mode: wantMode, reason: "already-sent" };
    }
  }

  const rows = [];
  const zip = new JSZip();

  for (const o of orders) {
    const om = String(o.mode || "test").toLowerCase();
    if (om !== wantMode) continue;
    if (monthIdUTC(o.created) !== nowMonth) continue;

    const html = renderOrderEmailHTML(o);
    zip.file(`receipt-${wantMode}-${o.id}.html`, html);

    rows.push(...buildReceiptXlsxRows(o));
  }

  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipts"
  );
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  zip.file(`receipts-${wantMode}-${nowMonth}.xlsx`, xlsxBuf);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const zipB64 = Buffer.from(zipBuf).toString("base64");

  if (!RESEND_FROM) throw new Error("RESEND_FROM missing");
const from = RESEND_FROM;
  const subject = `Monthly Receipts ZIP — ${nowMonth} (${wantMode})`;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">Attached: receipts ZIP for <b>${nowMonth}</b> (${wantMode}).</div>`,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipts-${wantMode}-${nowMonth}.zip`,
        content: zipB64,
        content_type: "application/zip",
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipts-zip-monthly:${wantMode}:${nowMonth}`
  );

  if (retry.ok) {
    // ✅ Mark as sent (LIVE/LIVE_TEST only) so daily cron won't re-send
    if (enforceMonthlyOnce) {
      await kvSetSafe(sentKey, {
        sentAt: new Date().toISOString(),
        month: nowMonth,
        mode: wantMode,
        subject,
      });
    }

    return { ok: true, month: nowMonth, mode: wantMode };
  }

  return { ok: false, error: retry.error?.message || String(retry.error) };
}

async function emailFinalReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();

  const rows = [];
  const zip = new JSZip();

  for (const o of orders) {
    const om = String(o.mode || "test").toLowerCase();
    if (om !== wantMode) continue;

    const html = renderOrderEmailHTML(o);
    zip.file(`receipt-${wantMode}-${o.id}.html`, html);
    rows.push(...buildReceiptXlsxRows(o));
  }

  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipts"
  );
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  zip.file(`receipts-${wantMode}-ALL.xlsx`, xlsxBuf);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const zipB64 = Buffer.from(zipBuf).toString("base64");

  if (!RESEND_FROM) throw new Error("RESEND_FROM missing");
const from = RESEND_FROM;
  const subject = `FINAL Receipts ZIP — ALL (${wantMode})`;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">Attached: <b>FINAL</b> receipts ZIP (ALL) for mode (${wantMode}).</div>`,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipts-${wantMode}-FINAL.zip`,
        content: zipB64,
        content_type: "application/zip",
      },
    ],
  };

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipts-zip-final:${wantMode}`
  );
  return retry.ok ? { ok: true } : { ok: false, error: retry.error?.message || String(retry.error) };
}

export {
  monthIdUTC,
  weekKeyUTC,
  weekRangeUTC,
  weeklyReceiptsZipSentKey,
  monthlyReceiptsZipSentKey,
  emailWeeklyReceiptsZip,
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,
};
