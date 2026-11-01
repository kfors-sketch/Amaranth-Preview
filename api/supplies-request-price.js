// /api/supplies-request-price.js
import { Resend } from "resend";
import { kv } from "@vercel/kv";
import { enforcePublicFormRateLimit, validateSuppliesInput } from "./admin/public-form-security.js";

const json = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
};

const esc = (s) => String(s || "").replace(/[<>&"]/g, c => (
  c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;"
));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM = process.env.RESEND_FROM || "Amaranth <no-reply@yourdomain.com>";

  const TO_GRAND_SECRETARY = (process.env.GRAND_SECRETARY_EMAIL || process.env.EMAIL_CONTACT); // required
  const CC_ME = process.env.SUPPLIES_PRICE_CC || "kfors@verizon.net"; // you

  let body;
  try {
    if (typeof req.body === "string" && Buffer.byteLength(req.body, "utf8") > 16_384) throw new Error("body-too-large");
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return json(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  const checked = validateSuppliesInput(body);
  if (checked.error === "bot-detected") return json(res, 200, { ok: true });
  if (checked.error) return json(res, 400, { ok: false, error: checked.error });
  const limited = await enforcePublicFormRateLimit(kv, req, "supplies-price");
  if (!limited.ok) return json(res, limited.unavailable ? 503 : 429, { ok: false, error: limited.unavailable ? "rate-limit-unavailable" : "rate-limited" });
  if (!RESEND_API_KEY || !TO_GRAND_SECRETARY) return json(res, 503, { ok: false, error: "mail-unavailable" });

  const item = checked.value.item;
  const purchaser = checked.value.purchaser;
  const notes = checked.value.notes;

  const itemName = item?.name || "";
  const category = item?.category || "";
  const itemId = item?.id || "";

  const name = purchaser?.name || "";
  const email = purchaser?.email || "";
  const phone = purchaser?.phone || "";
  const courtName = purchaser?.courtName || "";
  const courtNumber = purchaser?.courtNumber || "";

  const subject = `Supplies Price Request — ${itemName} — Court #${courtNumber}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.4">
      <h2 style="margin:0 0 12px">Supplies Price Request</h2>

      <h3 style="margin:14px 0 6px">Item</h3>
      <div><b>Category:</b> ${esc(category)}</div>
      <div><b>Item:</b> ${esc(itemName)}</div>
      <div><b>Item ID:</b> ${esc(itemId)}</div>

      <h3 style="margin:14px 0 6px">Purchaser</h3>
      <div><b>Name:</b> ${esc(name)}</div>
      <div><b>Email:</b> ${esc(email)}</div>
      <div><b>Phone:</b> ${esc(phone)}</div>

      <h3 style="margin:14px 0 6px">Court</h3>
      <div><b>Court Name:</b> ${esc(courtName)}</div>
      <div><b>Court #:</b> ${esc(courtNumber)}</div>

      ${notes ? `<h3 style="margin:14px 0 6px">Notes</h3><div>${esc(notes)}</div>` : ``}
    </div>
  `;

  try {
    const resend = new Resend(RESEND_API_KEY);

    const result = await resend.emails.send({
      from: RESEND_FROM,
      to: [TO_GRAND_SECRETARY],
      cc: [CC_ME],
      reply_to: email, // so Supreme Secretary can reply directly to purchaser
      subject,
      html
    });

    return json(res, 200, { ok: true, id: result?.id || null });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message || err) });
  }
}
