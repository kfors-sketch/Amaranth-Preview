import { resend, RESEND_FROM, REPLY_TO, EMAIL_RECEIPTS } from "./env.js";
import { sendWithRetry } from "./retry.js";
import { renderOrderEmailHTML } from "./receipts-render.js";
import { sendReceiptXlsxBackup } from "./receipt-xlsx-backup.js";

async function sendOrderReceipts(order, { adminEmail } = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };

  const purchaserEmail = String(order?.customer_email || order?.purchaser?.email || "").trim();
  const to = purchaserEmail ? [purchaserEmail] : [];
  const bcc = [];

  // If you want every order copied to a single admin inbox, pass adminEmail in
  const admin = String(adminEmail || "").trim();
  if (admin) bcc.push(admin);

  if (!to.length && !bcc.length) return { ok: false, error: "no-recipient" };

  if (!RESEND_FROM) throw new Error("RESEND_FROM missing");
  const from = RESEND_FROM;
  const subject = `Receipt — Order ${order?.id || ""}`.trim();
  const html = renderOrderEmailHTML(order);

  const payload = {
    from,
    to: to.length ? to : bcc,
    bcc: to.length && bcc.length ? bcc : undefined,
    subject,
    html,
    reply_to: REPLY_TO || undefined,
  };

  const retry = await sendWithRetry(() => resend.emails.send(payload), `receipt:${order?.id || ""}`);

  if (retry.ok) {
    const sendResult = retry.result;
    await recordMailLog({
      ts: Date.now(),
      from,
      to: [...to, ...bcc],
      subject,
      orderId: order?.id || "",
      resultId: sendResult?.id || null,
      status: "queued",
      kind: "receipt",
    });
    return { ok: true, resultId: sendResult?.id || null };
  }

  const err = retry.error;
  await recordMailLog({
    ts: Date.now(),
    from,
    to: [...to, ...bcc],
    subject,
    orderId: order?.id || "",
    resultId: null,
    status: "error",
    kind: "receipt",
    error: String(err?.message || err),
  });

  return { ok: false, error: err?.message || String(err) };
}

// ---------------------------------------------------------------------------
// Attendee roster collector (used by reports)
// ---------------------------------------------------------------------------


export { sendOrderReceipts };
