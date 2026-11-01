// /api/admin/contact-router.js
import {
  CONTACT_TO,
  REQ_OK,
  REQ_ERR,
  RESEND_FROM,
  REPLY_TO,
  getEffectiveSettings,
  recordMailLog,
  resend,
  sendWithRetry,
  kv,
} from "./core.js";
import { enforcePublicFormRateLimit, validateContactInput } from "./public-form-security.js";

export async function handleContactRoute(req, res, ctx = {}) {
  const {
    action,
    body = {},
    requestId = "",
    errResponse,
  } = ctx;

  if (action !== "contact_form") return false;

        if (req.method !== "POST") return REQ_ERR(res, 405, "method-not-allowed", { requestId });
        const checked = validateContactInput(body);
        if (checked.error === "bot-detected") return REQ_OK(res, { requestId, ok: true });
        if (checked.error) return REQ_ERR(res, 400, checked.error, { requestId });
        const limited = await enforcePublicFormRateLimit(kv, req, "contact");
        if (!limited.ok) return REQ_ERR(res, limited.unavailable ? 503 : 429, limited.unavailable ? "rate-limit-unavailable" : "rate-limited", { requestId });

        if (!resend && !CONTACT_TO)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });

        const {
          name = "",
          email = "",
          phone = "",
          topic = "",
          page = "",
          item = "",
          message: msg = "",
        } = checked.value;

        const topicMap = {
          banquets: "Banquets / meal choices",
          addons: "Grand Court of Pennsylvania add-ons (directory, love gifts, etc.)",
          catalog: "Product catalog / merchandise items",
          order: "Order / checkout issues",
          website: "Website or technical problem",
          general: "General question",
        };
        const pageMap = {
          home: "Home",
          banquet: "Banquets page",
          addons: "Grand Court of Pennsylvania Add-Ons page",
          catalog: "Product Catalog page",
          order: "Order page",
        };

        const topicLabel =
          topicMap[String(topic).toLowerCase()] ||
          String(topic) ||
          "General question";
        const pageLabel = pageMap[String(page).toLowerCase()] || String(page) || "";

        const esc = (s) => String(s ?? "").replace(/</g, "&lt;");
        const safe = (s) => String(s || "").trim();

        const createdIso = new Date().toISOString();
        const ua = req.headers["user-agent"] || "";
        const ip =
          req.headers["x-forwarded-for"] ||
          req.headers["x-real-ip"] ||
          req.socket?.remoteAddress ||
          "";

        const html = `
          <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
            <h2 style="margin-bottom:4px;">Website Contact Form</h2>
            <p style="margin:2px 0;">Time (UTC): ${esc(createdIso)}</p>
            <p style="margin:2px 0;">Topic: <b>${esc(topicLabel)}</b></p>
            ${pageLabel ? `<p style="margin:2px 0;">Page: <b>${esc(pageLabel)}</b></p>` : ""}
            <p style="margin:2px 0;font-size:12px;color:#555;">requestId: ${esc(
              requestId
            )}</p>
            <table style="border-collapse:collapse;border:1px solid #ccc;margin-top:10px;font-size:13px;">
              <tbody>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Name</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(name)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Email</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(email)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Phone</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(phone)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Topic</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(topicLabel)}</td>
                </tr>
                ${pageLabel ? `<tr><th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Page</th><td style="padding:4px 6px;border:1px solid #ddd;">${esc(pageLabel)}</td></tr>` : ""}
                ${item ? `<tr><th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Item</th><td style="padding:4px 6px;border:1px solid #ddd;">${esc(item)}</td></tr>` : ""}
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;vertical-align:top;">Message</th>
                  <td style="padding:6px 8px;border:1px solid #ddd;white-space:pre-wrap;">${esc(
                    msg
                  )}</td>
                </tr>
              </tbody>
            </table>
            <p style="margin-top:10px;font-size:12px;color:#555;">
              Technical details: IP=${esc(ip)} · User-Agent=${esc(ua)}
            </p>
          </div>
        `;

        const { effective } = await getEffectiveSettings();
        const split = (val) =>
          String(val || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        const toList = [CONTACT_TO].filter(Boolean);
        const adminBccBase = split(
          effective.REPORTS_BCC ||
            effective.REPORTS_CC ||
            process.env.REPORTS_BCC ||
            process.env.REPORTS_CC ||
            ""
        );
        const senderEmail = safe(email).toLowerCase();
        const bccList = adminBccBase.filter(
          (addr) => !toList.includes(addr) && addr.toLowerCase() !== senderEmail
        );

        if (!toList.length && !bccList.length)
          return REQ_ERR(res, 500, "no-recipient", { requestId });
        if (!resend)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });

        const subject = `Website contact — ${topicLabel}`;

        const payload = {
          from: RESEND_FROM || "onboarding@resend.dev",
          to: toList.length ? toList : bccList,
          bcc: toList.length && bccList.length ? bccList : undefined,
          subject,
          html,
          reply_to: senderEmail || REPLY_TO || undefined,
        };

        const retry = await sendWithRetry(
          () => resend.emails.send(payload),
          "contact-form"
        );

        if (retry.ok) {
          const sendResult = retry.result;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "queued",
            resultId: sendResult?.id || null,
          });
          return REQ_OK(res, { requestId, ok: true });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "error",
            error: String(err?.message || err),
          });
          return errResponse(res, 500, "contact-send-failed", req, err);
        }
      

  return true;
}
