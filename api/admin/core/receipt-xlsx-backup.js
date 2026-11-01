import { resend, RESEND_FROM, REPLY_TO } from "./env.js";
import { sendWithRetry } from "./retry.js";

async function sendReceiptXlsxBackup(order) {
  if (!resend || !EMAIL_RECEIPTS) return { ok: false, reason: "not-configured" };

  const orderId = String(order?.id || "").trim();
  if (!orderId) return { ok: false, reason: "missing-order-id" };

  const already = await kvGetSafe(receiptXlsxSentKey(orderId), null);
  if (already) return { ok: true, skipped: true, reason: "already-sent" };

  const rows = buildReceiptXlsxRows(order);
  const xlsxRaw = await objectsToXlsxBuffer(
    RECEIPT_XLSX_HEADERS,
    rows,
    RECEIPT_XLSX_HEADER_LABELS,
    "Receipt"
  );

  // ✅ ATTACHMENT HARDENING (ExcelJS can return ArrayBuffer)
  const xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);

  const mode = String(order?.mode || "test").toLowerCase();
  const purchaserEmail = String(order?.purchaser?.email || order?.customer_email || "").trim();

  const subject = `Receipt XLSX backup — ${orderId}${mode ? ` (${mode})` : ""}`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
      <h2 style="margin:0 0 6px;">Receipt Backup (XLSX)</h2>
      <div>Order ID: <b>${orderId.replace(/</g, "&lt;")}</b></div>
      ${purchaserEmail ? `<div>Purchaser: <b>${purchaserEmail.replace(/</g, "&lt;")}</b></div>` : ""}
      <div style="margin-top:10px;color:#555;font-size:12px;">
        Automated backup copy in a standard spreadsheet format (stable headers &amp; order).
      </div>
    </div>
  `;

  if (!RESEND_FROM) throw new Error("RESEND_FROM missing");
  const from = RESEND_FROM;

  const payload = {
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    html,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename: `receipt-${mode || "test"}-${orderId}.xlsx`,
        content: xlsxBuf,
        // optional hints; safe if ignored
        content_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };

  const throttleMs = parseInt(process.env.REPORTS_THROTTLE_MS || "0", 10);
  if (throttleMs > 0 && Number.isFinite(throttleMs)) {
    await sleep(throttleMs);
  }

  const retry = await sendWithRetry(
    () => resend.emails.send(payload),
    `receipt:xlsx-backup:${orderId}`
  );

  if (retry.ok) {
    const sendResult = retry.result;
    await kvSetSafe(receiptXlsxSentKey(orderId), {
      sentAt: new Date().toISOString(),
      to: EMAIL_RECEIPTS,
      mode,
      resultId: sendResult?.id || null,
    });

    await recordMailLog({
      ts: Date.now(),
      from,
      to: [EMAIL_RECEIPTS],
      subject,
      orderId: order?.id || "",
      resultId: sendResult?.id || null,
      status: "queued",
      kind: "receipt-xlsx-backup",
      attachment: {
        filename: `receipt-${mode || "test"}-${orderId}.xlsx`,
        bytes: xlsxBuf.length,
      },
    });

    return { ok: true };
  }

  const err = retry.error;
  await recordMailLog({
    ts: Date.now(),
    from,
    to: [EMAIL_RECEIPTS],
    subject,
    orderId: order?.id || "",
    resultId: null,
    status: "error",
    kind: "receipt-xlsx-backup",
    error: String(err?.message || err),
  });

  return { ok: false, error: err?.message || String(err) };
}

// ---------------------------------------------------------------------------
// Order receipts sender (main receipt email + optional admin copies)
// ---------------------------------------------------------------------------


export { sendReceiptXlsxBackup };
