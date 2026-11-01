// /api/admin/debug-router.js
import { kv, REQ_OK } from "./core.js";
import { authorizeDebugRoute } from "./debug-auth.js";

import {
  handleSmoketest,
  handleLastMail,
  handleTokenTest,
  handleStripeTest,
  handleResendTest,
  handleSchedulerDiagnostic,
  handleOrdersHealth,
  handleItemcfgHealth,
  handleSchedulerDryRun,
  handleChairPreview,
  handleOrderPreview,
  handleWebhookPreview,
} from "../../admin/debug.js";

export async function handleDebugRoute(req, res, ctx = {}) {
  const {
    url,
    type,
    requestId = "",
    requireAdminAuth,
    errResponse,
  } = ctx;

  if (req.method !== "GET") return false;

  const debugAuth = await authorizeDebugRoute({ type, requireAdminAuth, req, res });
  if (!debugAuth.handled) return false;
  if (!debugAuth.authorized) return true;

  if (type === "smoketest") {
    const out = await handleSmoketest();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "lastmail") {
    const out = await handleLastMail();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_mail_recent") {
    const limitRaw = url.searchParams.get("limit") || "20";
    let limit = Number(limitRaw);
    if (!Number.isFinite(limit)) limit = 20;
    limit = Math.max(1, Math.min(200, Math.floor(limit)));

    let logs = [];
    try {
      logs = await kv.lrange("mail:logs", 0, limit - 1);
    } catch (e) {
      return errResponse(res, 500, "debug-mail-recent-failed", req, e);
    }

    return REQ_OK(res, { requestId, ok: true, limit, logs });
  }

  if (type === "debug_token") {
    const out = await handleTokenTest(req);
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_stripe") {
    const out = await handleStripeTest();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_resend") {
    const out = await handleResendTest(req, url);
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_scheduler") {
    const out = await handleSchedulerDiagnostic();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_orders_health") {
    const out = await handleOrdersHealth();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_itemcfg_health") {
    const out = await handleItemcfgHealth();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_scheduler_dry_run") {
    const out = await handleSchedulerDryRun();
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_chair_preview") {
    const id = url.searchParams.get("id") || "";
    const scope = url.searchParams.get("scope") || "full";
    const out = await handleChairPreview({ id, scope });
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_order_preview") {
    const id = url.searchParams.get("id") || "";
    const out = await handleOrderPreview(id);
    return REQ_OK(res, { requestId, ...out });
  }

  if (type === "debug_webhook_preview") {
    const sessionId =
      url.searchParams.get("session_id") ||
      url.searchParams.get("sessionId") ||
      "";
    const out = await handleWebhookPreview(sessionId);
    return REQ_OK(res, { requestId, ...out });
  }

  return false;
}
