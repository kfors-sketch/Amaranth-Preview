// /api/router.js
import {
  getStripe,
  REQ_ERR,
  getEffectiveOrderChannel,
  saveOrderFromSession,
} from "./admin/core.js";

import { handleVisitsRoute } from "./admin/visits-router.js";
import { handleReceiptsZipRoute } from "./admin/receipts-router.js";
import { handleYoyRoute } from "./admin/yoy-router.js";
import { handleCatalogRoute } from "./admin/catalog-router.js";
import { handleSettingsRoute } from "./admin/settings-router.js";
import { handleContactRoute } from "./admin/contact-router.js";
import { handleItemsRoute } from "./admin/items-router.js";
import { handleAuthRoute } from "./admin/auth-router.js";
import { handleOrdersRoute } from "./admin/orders-router.js";
import { handleReportsRoute } from "./admin/reports-router.js";
import { handleAdminToolsRoute } from "./admin/admin-tools-router.js";
import { handleStripeInfoRoute } from "./admin/stripe-info-router.js";
import { handleFinalizeRoute } from "./admin/finalize-router.js";
import { handleCheckoutRoute } from "./admin/checkout-router.js";
import { handleWebhookRoute } from "./admin/webhook-router.js";
import {
  getClientIp,
  getLockdownStateSafe,
  isLockdownBypassed,
  enforceLockdownIfNeeded,
} from "./admin/lockdown-utils.js";
import {
  resolveModeFromSession,
  ensureOrderIntegrityMarkers,
  sendPostOrderEmails,
} from "./admin/order-lifecycle.js";
import { verifyAdminToken } from "./admin/security.js";
import { handleDebugRoute } from "./admin/debug-router.js";
import { handleManualOrdersRoute } from "./admin/manual-orders-router.js";

function getRequestId(req) {
  return (
    req?.headers?.["x-vercel-id"] ||
    req?.headers?.["x-request-id"] ||
    `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function errResponse(res, status, code, req, err, extra = {}) {
  const requestId = getRequestId(req);
  console.error(`[router] ${code} requestId=${requestId}`, err);
  return REQ_ERR(res, status, code, {
    requestId,
  });
}

async function readRawBody(req) {
  if (req._rawBodyBuffer) return req._rawBodyBuffer;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const buf = Buffer.concat(chunks);
  req._rawBodyBuffer = buf;
  return buf;
}

async function readJsonBody(req) {
  const buf = await readRawBody(req);
  const text = buf.toString("utf8") || "";
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON body: ${e?.message || e}`);
  }
}

async function requireAdminAuth(req, res) {
  const headers = req.headers || {};
  const auth = String(headers.authorization || headers.Authorization || "");

  if (!auth.toLowerCase().startsWith("bearer ")) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }

  const token = auth.slice(7).trim();
  if (!token) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }

  const legacy = (process.env.REPORT_TOKEN || "").trim();
  if (legacy && token === legacy) return true;

  try {
    const result = await verifyAdminToken(token);
    if (result.ok) return true;
  } catch (e) {
    console.error("verifyAdminToken failed:", e?.message || e);
  }

  REQ_ERR(res, 401, "unauthorized");
  return false;
}

function getUrl(req) {
  const host = req?.headers?.host || req?.headers?.["host"] || "localhost";
  return new URL(req.url, `http://${host}`);
}

export default async function handler(req, res) {
  const requestId = getRequestId(req);

  try {
    const url = getUrl(req);
    const action = url.searchParams.get("action");
    const type = url.searchParams.get("type");

    if (req.method === "GET") {
      const baseCtx = {
        url,
        type,
        action,
        body: null,
        requestId,
        requireAdminAuth,
        errResponse,
      };

      if (await handleVisitsRoute(req, res, baseCtx)) return;
      if (await handleReceiptsZipRoute(req, res, baseCtx)) return;
      if (await handleYoyRoute(req, res, baseCtx)) return;

      if (
        await handleCatalogRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
        })
      ) return;

      if (
        await handleSettingsRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
          getLockdownStateSafe,
          isLockdownBypassed,
          getClientIp,
        })
      ) return;

      if (await handleDebugRoute(req, res, baseCtx)) return;

      if (
        await handleItemsRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
        })
      ) return;

      if (await handleOrdersRoute(req, res, baseCtx)) return;

      if (
        await handleReportsRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
        })
      ) return;

      if (await handleStripeInfoRoute(req, res, baseCtx)) return;

      if (
        await handleFinalizeRoute(req, res, {
          ...baseCtx,
          getEffectiveOrderChannel,
          saveOrderFromSession,
          ensureOrderIntegrityMarkers,
          sendPostOrderEmails,
        })
      ) return;
    }

    if (req.method === "POST") {
      let body = {};
      try {
        if (action !== "stripe_webhook") body = await readJsonBody(req);
      } catch (e) {
        return errResponse(res, 400, "invalid-json", req, e);
      }

      const baseCtx = {
        url,
        type,
        action,
        body,
        requestId,
        requireAdminAuth,
        errResponse,
      };

      if (await handleVisitsRoute(req, res, baseCtx)) return;
      if (await handleReceiptsZipRoute(req, res, baseCtx)) return;

      if (
        await handleCatalogRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
        })
      ) return;

      if (
        await handleSettingsRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
          getLockdownStateSafe,
          isLockdownBypassed,
          getClientIp,
        })
      ) return;

      if (await handleContactRoute(req, res, baseCtx)) return;

      if (
        await handleItemsRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
        })
      ) return;

      if (await handleAuthRoute(req, res, baseCtx)) return;

      if (
        await handleReportsRoute(req, res, {
          ...baseCtx,
          enforceLockdownIfNeeded,
        })
      ) return;

      if (
        await handleFinalizeRoute(req, res, {
          ...baseCtx,
          getStripe,
          getEffectiveOrderChannel,
          saveOrderFromSession,
          ensureOrderIntegrityMarkers,
          sendPostOrderEmails,
        })
      ) return;

      if (await handleCheckoutRoute(req, res, baseCtx)) return;

      if (
        await handleWebhookRoute(req, res, {
          ...baseCtx,
          readRawBody,
          resolveModeFromSession,
          ensureOrderIntegrityMarkers,
          sendPostOrderEmails,
        })
      ) return;

      if (!(await requireAdminAuth(req, res))) return;
      if (!(await enforceLockdownIfNeeded(req, res, action, requestId))) return;

      if (await handleManualOrdersRoute(req, res, baseCtx)) return;

      if (
        await handleAdminToolsRoute(req, res, {
          ...baseCtx,
          getClientIp,
        })
      ) return;

      return REQ_ERR(res, 400, "unknown-action", { requestId });
    }

    return REQ_ERR(res, 405, "method-not-allowed", { requestId });
  } catch (e) {
    return errResponse(res, 500, "router-failed", req, e);
  }
}

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};
