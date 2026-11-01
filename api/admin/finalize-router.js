// /api/admin/finalize-router.js
// Handles finalizing completed checkout sessions into saved orders.

import { REQ_OK, REQ_ERR } from "./core.js";

export async function handleFinalizeRoute(req, res, ctx = {}) {
  const {
    url,
    type,
    action,
    body = {},
    requestId,
    getStripe,
    getEffectiveOrderChannel,
    saveOrderFromSession,
    ensureOrderIntegrityMarkers,
    sendPostOrderEmails,
    errResponse,
  } = ctx;

  if (req.method === "GET" && type === "finalize_order") {
    return !!REQ_ERR(res, 410, "finalization-webhook-only", { requestId });
  }

  if (req.method === "POST" && action === "finalize_checkout") {
    return !!REQ_ERR(res, 410, "finalization-webhook-only", { requestId });
  }

  return false;
}
