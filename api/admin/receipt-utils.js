// /api/admin/receipt-utils.js
import { cents, kvGetSafe, kvSetSafe } from "./kv-utils.js";
import { resend, RESEND_FROM, REPLY_TO, EMAIL_RECEIPTS, sleep, sendWithRetry, recordMailLog } from "./mail-utils.js";
import { objectsToXlsxBuffer } from "./export-utils.js";

function computeStripeProcessingFeeFromLines(
  lines,
  { stripePct = 0.029, stripeFlatCents = 30 } = {}
) {
  if (!Array.isArray(lines) || !lines.length) return 0;

  let itemsSubtotal = 0;
  let shipping = 0;

  for (const li of lines) {
    const name = li.itemName || "";
    const qty = Number(li.qty || 1);
    const lineCents = Number(li.unitPrice || 0) * qty;
    const cat = String(li.category || "").toLowerCase();
    const itemId = String(li.itemId || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();

    const isProcessingFee =
      itemId === "processing-fee" ||
      ((cat === "fee" || metaType === "fee" || metaType === "other") &&
        /processing\s*fee/i.test(name));
    const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);
    const isShipping = cat === "shipping" || metaType === "shipping" || itemId === "shipping";

    if (isProcessingFee || isIntlFee) continue;
    if (isShipping) {
      shipping += lineCents;
      continue;
    }
    itemsSubtotal += lineCents;
  }

  const base = itemsSubtotal + shipping;
  if (base <= 0) return 0;
  return Math.round(base * stripePct + stripeFlatCents);
}

// -------- Email rendering + sending (receipts) --------
function absoluteUrl(path = "/") {
  const base = (process.env.SITE_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

function renderOrderEmailHTML(order) {
  const money = (c) =>
    (Number(c || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const logoUrl = absoluteUrl("/assets/img/receipt_logo.svg");
  const purchaserName = order?.purchaser?.name || "Purchaser";
  const lines = order.lines || [];

  const topCatalog = [];
  const attendeeGroups = {};
  let processingFeeCents = 0;
  let intlFeeCents = 0;

  (lines || []).forEach((li) => {
    const name = li.itemName || "";
    const qty = Number(li.qty || 1);
    const lineCents = Number(li.unitPrice || 0) * qty;
    const cat = String(li.category || "").toLowerCase();
    const itemId = String(li.itemId || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();

    const isProcessingFee =
      itemId === "processing-fee" ||
      ((cat === "fee" || metaType === "fee" || metaType === "other") &&
        /processing\s*fee/i.test(name));
    const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);

    if (isProcessingFee) {
      processingFeeCents += lineCents;
      return;
    }
    if (isIntlFee) {
      intlFeeCents += lineCents;
      return;
    }

    const isBanquet = cat === "banquet" || /banquet/i.test(name);
    const isAddon = cat === "addon" || /addon/i.test(li.meta?.itemType || "") || /addon/i.test(name);
    const isTour = cat === "tour" || String(li.meta?.itemType || "").toLowerCase() === "tour";

    if (isBanquet || isAddon || isTour) {
      const attName = (li.meta && li.meta.attendeeName) || purchaserName;
      (attendeeGroups[attName] ||= []).push(li);
    } else {
      topCatalog.push(li);
    }
  });

  const renderTable = (rows) => {
    const bodyRows = rows
      .map((li) => {
        const cat = String(li.category || "").toLowerCase();
        const isBanquet = cat === "banquet" || /banquet/i.test(li.itemName || "");
        const itemIdLower = String(li.itemId || "").toLowerCase();

        // Corsage: append choice + wear style directly on the line item label
        let itemLabel = li.itemName || "";
        // Pre-Registration: append Voting / Non-Voting to label + notes (receipt-safe)
        const itemNameLower = String(li.itemName || "").toLowerCase();
        const isPreReg =
          (itemIdLower.includes("pre") && (itemIdLower.includes("reg") || itemIdLower.includes("registration"))) ||
          itemNameLower.includes("pre-registration") ||
          itemNameLower.includes("pre registration") ||
          itemNameLower.includes("pre reg") ||
          itemNameLower.includes("prereg");

        let preRegVotingLabel = "";
        if (isPreReg) {
          const blob = [
            li.meta?.voting_status,
            li.meta?.votingStatus,
            li.meta?.voting,
            li.meta?.isVoting,
            li.meta?.attendeeTitle,
            li.meta?.attendeeNotes,
            li.meta?.itemNote,
            itemLabel,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          if (/non\s*-?\s*voting/.test(blob) || /nonvoting/.test(blob)) preRegVotingLabel = "Non-Voting";
          else if (/\bvoting\b/.test(blob)) preRegVotingLabel = "Voting";

          if (preRegVotingLabel) {
            const il = String(itemLabel || "").toLowerCase();
            if (!il.includes("non-voting") && !il.includes("nonvoting") && !il.includes("voting")) {
              itemLabel += ` (${preRegVotingLabel})`;
            }
          }
        }

        if (itemIdLower === "corsage") {
          const rawChoice = String(li.meta?.corsageChoice || li.meta?.corsage_choice || "").trim();
          const isCustom = !!li.meta?.corsageIsCustom || /custom/i.test(rawChoice);
          const choiceLabel = isCustom ? "Custom" : (rawChoice || "");
          const wear = String(li.meta?.corsageWear || li.meta?.corsage_wear || "").toLowerCase();
          const wearLabel = wear === "wrist" ? "Wrist" : (wear === "pin" ? "Pin-on" : "");

          const baseLower = itemLabel.toLowerCase();

          // Only append choice if it's not already present in the existing itemName
          if (choiceLabel && !baseLower.includes(choiceLabel.toLowerCase())) {
            itemLabel += ` (${choiceLabel.replace(/</g,"&lt;")})`;
          }
}

        const preRegNotes =
          isPreReg && preRegVotingLabel ? `Member: ${preRegVotingLabel}` : "";

        const notes = isBanquet
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : [li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote, preRegNotes]
              .filter(Boolean)
              .join("; ");
        const notesRow = notes
          ? `<div style="font-size:12px;color:#444;margin-top:2px">Notes: ${String(notes).replace(
              /</g,
              "&lt;"
            )}</div>`
          : "";
        const lineTotal = Number(li.unitPrice || 0) * Number(li.qty || 1);
        return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee">
            ${itemLabel}${notesRow}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(
            li.qty || 1
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(
            li.unitPrice || 0
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(
            lineTotal
          )}</td>
        </tr>`;
      })
      .join("");

    const subtotal = rows.reduce((s, li) => s + Number(li.unitPrice || 0) * Number(li.qty || 1), 0);

    return `
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Item</th>
            <th style="text-align:center;padding:8px;border-bottom:1px solid #ddd">Qty</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #ddd">Price</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #ddd">Line</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">Subtotal</td>
            <td style="text-align:right;padding:8px;border-top:2px solid #ddd;font-weight:700">${money(
              subtotal
            )}</td>
          </tr>
        </tfoot>
      </table>`;
  };

  const topCatalogHtml = topCatalog.length
    ? `
      <div style="margin-top:14px">
        <div style="font-weight:700;margin:8px 0 6px">${purchaserName} — Catalog Items</div>
        ${renderTable(topCatalog)}
      </div>`
    : "";

  const attendeeHtml = Object.entries(attendeeGroups)
    .map(
      ([attName, list]) => `
    <div style="margin-top:14px">
      <div style="font-weight:700;margin:8px 0 6px">${attName} — Banquets & Addons</div>
      ${renderTable(list)}
    </div>`
    )
    .join("");

  const { itemsSubtotalCents, shippingCents } = (function () {
    let itemsSubtotal = 0;
    let shipping = 0;

    for (const li of lines) {
      const name = li.itemName || "";
      const qty = Number(li.qty || 1);
      const lineCents = Number(li.unitPrice || 0) * qty;
      const cat = String(li.category || "").toLowerCase();
      const itemId = String(li.itemId || "").toLowerCase();
      const metaType = String(li.meta?.itemType || "").toLowerCase();

      const isProcessingFee =
        itemId === "processing-fee" ||
        ((cat === "fee" || metaType === "fee" || metaType === "other") &&
          /processing\s*fee/i.test(name));
      const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);
      const isShipping = cat === "shipping" || metaType === "shipping" || itemId === "shipping";

      if (isProcessingFee || isIntlFee) continue;
      if (isShipping) {
        shipping += lineCents;
        continue;
      }
      itemsSubtotal += lineCents;
    }

    return { itemsSubtotalCents: itemsSubtotal, shippingCents: shipping };
  })();

  const grandTotalCents = itemsSubtotalCents + shippingCents + processingFeeCents + intlFeeCents;
  const totalCents = grandTotalCents > 0 ? grandTotalCents : Number(order.amount_total || 0);

  const shippingRow =
    shippingCents > 0
      ? `
      <tr>
        <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">Shipping &amp; Handling</td>
        <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(
          shippingCents
        )}</td>
      </tr>`
      : "";

  const processingRow =
    processingFeeCents > 0
      ? `
      <tr>
        <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">Online Processing Fee</td>
        <td style="text-align:right;padding:8px;border-top:1px solid:#eee">${money(
          processingFeeCents
        )}</td>
      </tr>`
      : "";

  const intlRow =
    intlFeeCents > 0
      ? `
      <tr>
        <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid #eee">International Card Processing Fee (3%)</td>
        <td style="text-align:right;padding:8px;border-top:1px solid #eee">${money(
          intlFeeCents
        )}</td>
      </tr>`
      : "";

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;color:#111;margin:0;">
  <div style="max-width:720px;margin:0 auto;padding:16px 20px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <img src="${absoluteUrl("/assets/img/receipt_logo.svg")}" alt="Logo" style="height:28px;max-width:160px;object-fit:contain" />
      <div>
        <div style="font-size:18px;font-weight:800">Grand Court of Pennsylvania — Order of the Amaranth</div>
        <div style="font-size:14px;color:#555">Order #${order.id}</div>
      </div>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-top:8px">
      <div style="font-weight:700;margin-bottom:8px">Purchaser</div>
      <div>${order?.purchaser?.name || "Purchaser"}</div>
      <div>${order.customer_email || ""}</div>
      <div>${order.purchaser?.phone || ""}</div>
    </div>

    <h2 style="margin:16px 0 8px">Order Summary</h2>
    ${topCatalogHtml}
    ${attendeeHtml || "<p>No items.</p>"}

    <table style="width:100%;border-collapse:collapse;margin-top:12px">
      <tfoot>
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:1px solid:#eee">Subtotal</td>
          <td style="text-align:right;padding:8px;border-top:1px solid:#eee">${(itemsSubtotalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
        </tr>
        ${shippingRow}
        ${processingRow}
        ${intlRow}
        <tr>
          <td colspan="3" style="text-align:right;padding:8px;border-top:2px solid:#ddd;font-weight:700">Total</td>
          <td style="text-align:right;padding:8px;border-top:2px solid:#ddd;font-weight:700">${(totalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
        </tr>
      </tfoot>
    </table>

    <p style="color:#666;font-size:12px;margin-top:12px">Thank you for your order!</p>
  </div>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Receipt XLSX backup (standard columns + year/month/day) → emailed to EMAIL_RECEIPTS
// ---------------------------------------------------------------------------

const RECEIPT_XLSX_HEADERS = [
  "year",
  "month",
  "day",
  "order_id",
  "date",
  "mode",
  "purchaser_name",
  "purchaser_email",
  "purchaser_phone",
  "attendee",
  "attendee_title",
  "attendee_email",
  "attendee_phone",
  "category",
  "item",
  "item_id",
  "qty",
  "unit_price",
  "line_total",
  "status",
  "notes",
  "_pi",
  "_charge",
  "_session",
];

const RECEIPT_XLSX_HEADER_LABELS = {
  year: "Year",
  month: "Month",
  day: "Day",
  order_id: "Order ID",
  date: "Date",
  mode: "Mode",
  purchaser_name: "Purchaser",
  purchaser_email: "Purchaser Email",
  purchaser_phone: "Purchaser Phone",
  attendee: "Attendee",
  attendee_title: "Title",
  attendee_email: "Attendee Email",
  attendee_phone: "Attendee Phone",
  category: "Category",
  item: "Item",
  item_id: "Item ID",
  qty: "Qty",
  unit_price: "Unit Price",
  line_total: "Line Total",
  status: "Status",
  notes: "Notes",
  _pi: "Payment Intent",
  _charge: "Charge",
  _session: "Session ID",
};

function deriveYMDParts(createdMs) {
  const d = new Date(Number(createdMs || Date.now()));
  const iso = d.toISOString();
  const day = iso.slice(0, 10);
  const year = day.slice(0, 4);
  const month = day.slice(0, 7);
  return { year, month, day, iso };
}

function buildReceiptXlsxRows(order) {
  const o = order || {};
  const { year, month, day, iso } = deriveYMDParts(o.created || Date.now());
  const mode = String(o.mode || "test").toLowerCase();
  const purchaserName =
    String(o?.purchaser?.name || "").trim() || String(o.customer_email || "").trim();
  const purchaserEmail = String(o?.purchaser?.email || o.customer_email || "").trim();
  const purchaserPhone = String(o?.purchaser?.phone || "").trim();
  const status = String(o.status || "paid");

  const rows = [];
  for (const li of o.lines || []) {
    const qty = Number(li?.qty || 1);
    const unit = Number(li?.unitPrice || 0);
    const lineCents = unit * qty;

    const cat = String(li?.category || "other").toLowerCase();
    const itemId = String(li?.itemId || "");
    const itemName = String(li?.itemName || "");

    const isBanquet = cat === "banquet" || /banquet/i.test(itemName);
    const notes = isBanquet
      ? [li?.meta?.attendeeNotes, li?.meta?.dietaryNote].filter(Boolean).join("; ")
      : [li?.meta?.corsageChoice, li?.meta?.itemNote, li?.meta?.corsageNote].filter(Boolean).join("; ");

    rows.push({
      year,
      month,
      day,
      order_id: String(o.id || ""),
      date: iso,
      mode,
      purchaser_name: purchaserName,
      purchaser_email: purchaserEmail,
      purchaser_phone: purchaserPhone,
      attendee: String(li?.meta?.attendeeName || ""),
      attendee_title: String(li?.meta?.attendeeTitle || ""),
      attendee_email: String(li?.meta?.attendeeEmail || ""),
      attendee_phone: String(li?.meta?.attendeePhone || ""),
      category: cat,
      item: itemName,
      item_id: itemId,
      qty: qty,
      unit_price: Number((unit / 100).toFixed(2)),
      line_total: Number((lineCents / 100).toFixed(2)),
      status,
      notes: String(notes || ""),
      _pi: String(o.payment_intent || ""),
      _charge: String(o.charge || ""),
      _session: String(o.id || ""),
    });
  }

  if (!rows.length) {
    const blank = {};
    for (const h of RECEIPT_XLSX_HEADERS) blank[h] = "";
    blank.year = year;
    blank.month = month;
    blank.day = day;
    blank.order_id = String(o.id || "");
    blank.date = iso;
    blank.mode = mode;
    blank.purchaser_email = purchaserEmail;
    blank.status = status;
    rows.push(blank);
  }

  return rows;
}

// Idempotency: don’t re-send XLSX backup for the same order
function receiptXlsxSentKey(orderId) {
  return `order:${String(orderId || "").trim()}:receipt_xlsx_sent`;
}

// ---------------------------------------------------------------------------
// CSV/XLSX helpers moved to ./export-utils.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Receipt XLSX backup sender
// ---------------------------------------------------------------------------

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


// ------------- EXPORTS -------------
export {
  computeStripeProcessingFeeFromLines,
  absoluteUrl,
  renderOrderEmailHTML,
  RECEIPT_XLSX_HEADERS,
  RECEIPT_XLSX_HEADER_LABELS,
  deriveYMDParts,
  buildReceiptXlsxRows,
  receiptXlsxSentKey,
  sendReceiptXlsxBackup,
  sendOrderReceipts,
};
