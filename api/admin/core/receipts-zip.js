import JSZip from "jszip";
import { resend, RESEND_FROM, REPLY_TO } from "./env.js";
import { sendWithRetry } from "./retry.js";
import { kvGetSafe } from "./kv.js";

async function emailWeeklyReceiptsZip({ mode = "test" } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!EMAIL_RECEIPTS) return { ok: false, error: "EMAIL_RECEIPTS-not-configured" };

  const orders = await loadAllOrdersWithRetry();
  const wantMode = String(mode || "test").toLowerCase();
  const weekKey = weekKeyUTC(Date.now())
  const { startMs, endMs } = weekRangeUTC(Date.now());

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

  const from = RESEND_FROM || "pa_sessions@yahoo.com";
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

  const from = RESEND_FROM || "pa_sessions@yahoo.com";
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

// ---------------------------------------------------------------------------

export { emailWeeklyReceiptsZip, emailMonthlyReceiptsZip, emailFinalReceiptsZip };
