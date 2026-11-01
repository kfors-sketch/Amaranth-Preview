// /api/admin/order-lifecycle.js
import crypto from "crypto";

import {
  resend,
  kv,
  RESEND_FROM,
  REPLY_TO,
  kvGetSafe,
  kvSetSafe,
  sendWithRetry,
  getEffectiveSettings,
  recordMailLog,
  renderOrderEmailHTML,
  sendOrderReceipts,
  maybeSendRealtimeChairEmails,
  getEffectiveOrderChannel,
} from "./core.js";

function splitEmails(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function resolveModeFromSession(sessionLike) {
  try {
    const md = sessionLike?.metadata || {};
    const m =
      String(md.order_channel || md.order_mode || "")
        .trim()
        .toLowerCase() || "";
    if (m === "test" || m === "live_test" || m === "live") return m;
  } catch {}

  try {
    const eff = await getEffectiveOrderChannel();
    if (eff === "test" || eff === "live_test" || eff === "live") return eff;
  } catch {}

  return "test";
}

function stableStringify(value) {
  const seen = new WeakSet();

  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);

    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };

  return JSON.stringify(walk(value));
}

function normalizeOrderForHash(order) {
  const o = order && typeof order === "object" ? order : {};
  const clone = { ...o };

  delete clone._raw;
  delete clone._debug;
  delete clone._requestId;
  delete clone._email;
  delete clone._emailStatus;
  delete clone._emailsSentAt;
  delete clone._postEmailsSentAt;
  delete clone.post_emails_sent;
  delete clone.admin_receipt_sent;
  delete clone.updatedAt;
  delete clone.lastUpdatedAt;

  return clone;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

export async function ensureOrderIntegrityMarkers(order, requestId) {
  try {
    const id = String(order?.id || "").trim();
    if (!id) return;

    const createdKey = `order:${id}:createdAt`;
    const hashKey = `order:${id}:hash`;

    const existingCreated = await kvGetSafe(createdKey, "");
    if (!existingCreated) {
      const createdAt =
        String(order?.createdAt || order?.created_at || "").trim() ||
        new Date().toISOString();
      await kvSetSafe(createdKey, createdAt);
    }

    const existingHash = await kvGetSafe(hashKey, "");
    if (!existingHash) {
      const normalized = normalizeOrderForHash(order);
      const payload = stableStringify(normalized);
      const hash = sha256Hex(payload);
      await kvSetSafe(hashKey, hash);
    }
  } catch (e) {
    console.error("[order-hash] failed", {
      requestId,
      orderId: order?.id || null,
      message: e?.message || String(e),
    });
  }
}

function postEmailKey(orderId) {
  return `order:${String(orderId || "").trim()}:post_emails_sent`;
}

async function claimPostEmailSend(orderId) {
  const key = postEmailKey(orderId);
  const result = await kv.set(key, "sending", { nx: true, ex: 10 * 60 });
  return result === "OK" || result === true;
}

function adminReceiptKey(orderId) {
  return `order:${String(orderId || "").trim()}:admin_receipt_sent`;
}

async function getAdminReceiptRecipientsSafe() {
  try {
    const { effective } = await getEffectiveSettings();
    const pick = (effective?.EMAIL_RECEIPTS || "").trim();
    const list = splitEmails(pick);
    if (list.length) return list;
  } catch {}

  return splitEmails((process.env.EMAIL_RECEIPTS || "").trim());
}

async function sendAdminReceiptCopyOnce(order, requestId) {
  try {
    if (!order?.id) return;
    if (!resend) return;

    const already = await kvGetSafe(adminReceiptKey(order.id), "");
    if (already) return;

    const toList = await getAdminReceiptRecipientsSafe();
    if (!toList.length) return;

    const html =
      (await renderOrderEmailHTML(order, { includeAdminNote: true })) ||
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
        <h2>Order receipt</h2>
        <p>orderId: ${String(order.id).replace(/</g, "&lt;")}</p>
      </div>`;

    const payload = {
      from: RESEND_FROM || "onboarding@resend.dev",
      to: toList,
      subject: `Admin copy — receipt — Order ${order.id}`,
      html,
      reply_to: REPLY_TO || undefined,
    };

    const retry = await sendWithRetry(
      () => resend.emails.send(payload),
      "admin-receipt"
    );

    if (retry.ok) {
      const sendResult = retry.result;
      await kvSetSafe(adminReceiptKey(order.id), new Date().toISOString());
      try {
        await recordMailLog({
          ts: Date.now(),
          from: payload.from,
          to: toList,
          subject: payload.subject,
          resultId: sendResult?.id || null,
          kind: "admin-receipt",
          status: "queued",
        });
      } catch {}
    } else {
      const err = retry.error;
      console.error("[admin-receipt] send failed", {
        requestId,
        orderId: order?.id || null,
        message: err?.message || String(err),
      });
      try {
        await recordMailLog({
          ts: Date.now(),
          from: payload.from,
          to: toList,
          subject: payload.subject,
          kind: "admin-receipt",
          status: "error",
          error: String(err?.message || err),
        });
      } catch {}
    }
  } catch (e) {
    console.error("[admin-receipt] unexpected failure", {
      requestId,
      orderId: order?.id || null,
      message: e?.message || String(e),
    });
  }
}

export async function sendPostOrderEmails(order, requestId) {
  try {
    if (!order?.id) return;

    try {
      const er = (process.env.EMAIL_RECEIPTS || "").trim();
      if (!process.env.RECEIPTS_ADMIN_TO && er) process.env.RECEIPTS_ADMIN_TO = er;
    } catch {}

    const claimed = await claimPostEmailSend(order.id);
    if (!claimed) return;

    let customerReceiptSent = false;

    try {
      const receiptResult = await sendOrderReceipts(order);
      customerReceiptSent = !!receiptResult?.ok;
      if (!customerReceiptSent) {
        throw new Error(receiptResult?.error || "receipt-send-failed");
      }
    } catch (err) {
      console.error("[post-email] sendOrderReceipts failed", {
        requestId,
        orderId: order?.id || null,
        message: err?.message || String(err),
      });
      try {
        await recordMailLog({
          ts: Date.now(),
          from: RESEND_FROM || "onboarding@resend.dev",
          to: [],
          subject: `receipts-failed order=${order?.id || ""}`,
          kind: "receipts",
          status: "error",
          error: String(err?.message || err),
        });
      } catch {}
    }

    await sendAdminReceiptCopyOnce(order, requestId);

    try {
      await maybeSendRealtimeChairEmails(order);
    } catch (err) {
      console.error("[post-email] maybeSendRealtimeChairEmails failed", {
        requestId,
        orderId: order?.id || null,
        message: err?.message || String(err),
      });
      try {
        await recordMailLog({
          ts: Date.now(),
          from: RESEND_FROM || "onboarding@resend.dev",
          to: [],
          subject: `realtime-chair-failed order=${order?.id || ""}`,
          kind: "realtime-chair",
          status: "error",
          error: String(err?.message || err),
        });
      } catch {}
    }

    if (customerReceiptSent) {
      await kvSetSafe(postEmailKey(order.id), new Date().toISOString());
    } else {
      await kv.del(postEmailKey(order.id)).catch(() => {});
    }
  } catch (e) {
    console.error("[post-email] unexpected failure", {
      requestId,
      orderId: order?.id || null,
      message: e?.message || String(e),
    });
    if (order?.id) await kv.del(postEmailKey(order.id)).catch(() => {});
  }
}
