// /api/admin/admin-tools-router.js
import {
  kv,
  getStripe,
  REQ_OK,
  REQ_ERR,
  cents,
  kvGetSafe,
  kvSetSafe,
  kvSaddSafe,
  kvSmembersSafe,
  kvDelSafe,
  getEffectiveOrderChannel,
  purgeOrdersByMode,
  applyRefundToOrder,
  patchOrderCourtFields,
  rehashOrderAfterAdminPatch,
  clearOrdersCache,
} from "./core.js";

import { debugScheduleForItem } from "../../admin/debug.js";

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !!v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

export async function handleAdminToolsRoute(req, res, ctx = {}) {
  const {
    url,
    action,
    body = {},
    requestId = "",
    errResponse,
    getClientIp = () => "",
  } = ctx;

  if (req.method !== "POST") return false;

  // Patch older orders with missing Court/Court# (admin-only via router pre-check).
  if (action === "admin_patch_order_court") {
    const orderId = String(body?.orderId || body?.id || "").trim();
    const courtName = String(body?.courtName || body?.court || "").trim();
    const courtNo = String(body?.courtNo || body?.court_number || body?.courtNumber || "").trim();
    const overwrite = coerceBool(body?.overwrite ?? false);

    if (!orderId) return REQ_ERR(res, 400, "missing-orderId", { requestId });
    if (!courtName && !courtNo) {
      return REQ_ERR(res, 400, "missing-court", {
        requestId,
        message: "Provide courtName and/or courtNo.",
      });
    }

    const key = `order:${orderId}`;
    const existing = await kvGetSafe(key, null);
    if (!existing) return REQ_ERR(res, 404, "order-not-found", { requestId, orderId });

    const patched = patchOrderCourtFields(existing, { courtName, courtNo, overwrite });
    if (!patched) return REQ_ERR(res, 500, "patch-failed", { requestId, orderId });

    const finalOrder = rehashOrderAfterAdminPatch(patched, {
      patchedBy: String(getClientIp(req) || ""),
      patchNote: "court_name_number",
    });

    await kvSetSafe(key, finalOrder);

    try {
      const logKey = "admin:order_patches";
      const entry = {
        ts: Date.now(),
        at: new Date().toISOString(),
        requestId,
        action,
        orderId,
        courtName,
        courtNo,
        overwrite,
        ip: String(getClientIp(req) || ""),
      };
      await kv.lpush(logKey, entry);
      await kv.ltrim(logKey, 0, 99);
    } catch {}

    try { clearOrdersCache(); } catch {}

    return REQ_OK(res, {
      requestId,
      ok: true,
      orderId,
      patched: { courtName, courtNo, overwrite },
    });
  }

  if (action === "debug_schedule") {
    const id = String(body?.id || url.searchParams.get("id") || "").trim();
    if (!id) {
      return REQ_ERR(res, 400, "missing-id", {
        requestId,
        message: "Missing id (body.id or ?id=)",
      });
    }
    try {
      const result = await debugScheduleForItem(id);
      return REQ_OK(res, { requestId, ...result });
    } catch (e) {
      return errResponse(res, 500, "debug-failed", req, e);
    }
  }

  if (action === "purge_orders") {
    const confirm = String(body?.confirm || "");
    if (confirm !== "PURGE ORDERS") {
      return REQ_ERR(res, 400, "confirmation-required", {
        requestId,
        expected: "PURGE ORDERS",
        received: confirm,
        note: "This safeguard prevents accidental data loss.",
      });
    }

    let mode = String(body?.mode || "").toLowerCase() || "test";
    const hardFlag = Boolean(body?.hard);

    if (!["test", "live_test", "live"].includes(mode)) {
      return REQ_ERR(res, 400, "invalid-mode", {
        requestId,
        mode,
        expected: ["test", "live_test", "live"],
      });
    }

    try {
      const result = await purgeOrdersByMode(mode, { hard: hardFlag });
      return REQ_OK(res, {
        requestId,
        ok: true,
        message:
          mode === "live"
            ? "Live orders purge requested. Core safety rules determine whether only soft-delete is allowed."
            : `Orders for mode="${mode}" purged successfully.`,
        ...result,
      });
    } catch (err) {
      return errResponse(res, 500, "purge-failed", req, err);
    }
  }

  if (action === "clear_orders") {
    await kvDelSafe("orders:index");
    return REQ_OK(res, { requestId, ok: true, message: "orders index cleared" });
  }

  if (action === "create_refund") {
    try {
      let mode = String(body?.mode || "").toLowerCase().trim();
      if (!["test", "live_test", "live"].includes(mode)) {
        mode = await getEffectiveOrderChannel().catch(() => "test");
      }

      const stripe = await getStripe(mode);
      if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured", { requestId, mode });

      const payment_intent = String(body.payment_intent || "").trim();
      const charge = String(body.charge || "").trim();
      const amount_cents_raw = body.amount_cents;
      const args = {};
      if (amount_cents_raw != null) args.amount = cents(amount_cents_raw);
      if (payment_intent) args.payment_intent = payment_intent;
      else if (charge) args.charge = charge;
      else return REQ_ERR(res, 400, "missing-payment_intent-or-charge", { requestId });

      const rf = await stripe.refunds.create(args);
      try { await applyRefundToOrder(rf.charge, rf); } catch {}
      return REQ_OK(res, { requestId, ok: true, id: rf.id, status: rf.status, mode });
    } catch (e) {
      return errResponse(res, 500, "refund-failed", req, e);
    }
  }

  if (action === "mark_manual_refund") {
    const orderId = String(body?.orderId || body?.order_id || "").trim();
    const rowId = String(body?.rowId || body?.row_id || body?.rowKey || "").trim();

    if (!orderId) return REQ_ERR(res, 400, "missing-orderId", { requestId });
    if (!rowId) return REQ_ERR(res, 400, "missing-rowId", { requestId });

    const rec = {
      orderId,
      rowId,
      itemId: String(body?.itemId || body?.item_id || "").trim() || null,
      itemName: String(body?.itemName || body?.item_name || body?.item || "").trim() || null,
      qty: Number.isFinite(Number(body?.qty)) ? Number(body.qty) : null,
      createdAt: String(body?.createdAt || body?.created_at || "").trim() || null,
      note: String(body?.note || "").trim() || null,
      markedAt: new Date().toISOString(),
    };

    const byOrderKey = `manual_refunds:byOrder:${orderId}`;
    const existing = (await kvGetSafe(byOrderKey, [])) || [];
    const list = Array.isArray(existing) ? existing : [];
    const without = list.filter((x) => String(x?.rowId || "") !== rowId);
    without.push(rec);

    await kvSetSafe(byOrderKey, without);
    await kvSaddSafe("manual_refunds:index", orderId);

    return REQ_OK(res, { requestId, ok: true, saved: true, orderId, rowId });
  }

  if (action === "unmark_manual_refund") {
    const orderId = String(body?.orderId || body?.order_id || "").trim();
    const rowId = String(body?.rowId || body?.row_id || body?.rowKey || "").trim();

    if (!orderId) return REQ_ERR(res, 400, "missing-orderId", { requestId });
    if (!rowId) return REQ_ERR(res, 400, "missing-rowId", { requestId });

    const byOrderKey = `manual_refunds:byOrder:${orderId}`;
    const existing = (await kvGetSafe(byOrderKey, [])) || [];
    const list = Array.isArray(existing) ? existing : [];
    const next = list.filter((x) => String(x?.rowId || "") !== rowId);
    await kvSetSafe(byOrderKey, next);

    return REQ_OK(res, { requestId, ok: true, removed: true, orderId, rowId });
  }

  if (action === "get_manual_refunds") {
    const orderIdsIn = Array.isArray(body?.orderIds) ? body.orderIds : null;
    let orderIds = orderIdsIn
      ? orderIdsIn.map((x) => String(x || "").trim()).filter(Boolean)
      : await kvSmembersSafe("manual_refunds:index");

    orderIds = Array.from(new Set(orderIds));

    const out = [];
    for (const oid of orderIds) {
      const byOrderKey = `manual_refunds:byOrder:${oid}`;
      const list = (await kvGetSafe(byOrderKey, [])) || [];
      if (Array.isArray(list)) {
        for (const rec of list) out.push(rec);
      }
    }

    return REQ_OK(res, { requestId, ok: true, count: out.length, records: out });
  }

  return false;
}
