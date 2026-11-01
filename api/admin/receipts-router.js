// /api/admin/receipts-router.js
// Handles Receipts ZIP routes so /api/router.js can stay smaller.

import {
  REQ_OK,
  REQ_ERR,
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,
} from "./core.js";

import { getReportingPrefs, setReportingPrefs, resolveChannel } from "./report-channel.js";

async function getEffectiveReportMode() {
  const prefs = await getReportingPrefs();
  const isProduction =
    String(process.env.VERCEL_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const mode = resolveChannel({ requested: prefs.channel, isProduction });
  return { prefs, mode };
}

export async function handleReceiptsZipRoute(req, res, ctx = {}) {
  const { url, type, action, body = {}, requestId, requireAdminAuth, errResponse } = ctx;

  if (req.method === "GET") {
    if (type === "receipts_zip_prefs") {
      if (!(await requireAdminAuth(req, res))) return true;
      const prefs = await getReportingPrefs();
      const { mode } = await getEffectiveReportMode();
      return !!REQ_OK(res, { requestId, ok: true, prefs, mode });
    }

    if (type === "receipts_zip_month") {
      if (!(await requireAdminAuth(req, res))) return true;

      try {
        const to = String(url.searchParams.get("to") || "").trim();
        const yearParam = url.searchParams.get("year");
        const monthParam = url.searchParams.get("month");

        const now = new Date();
        const year = Number(yearParam ?? now.getUTCFullYear());
        const month = Number(monthParam ?? (now.getUTCMonth() + 1));

        const result = await emailMonthlyReceiptsZip({
          to: to || undefined,
          year,
          month,
          requestId,
        });

        if (result && result.ok) return !!REQ_OK(res, { requestId, ...result });
        return !!REQ_ERR(res, 500, (result && result.error) || "zip-send-failed", {
          requestId,
          ...(result || {}),
        });
      } catch (e) {
        return !!errResponse(res, 500, "receipts-zip-month-failed", req, e);
      }
    }

    if (type === "receipts_zip_final") {
      if (!(await requireAdminAuth(req, res))) return true;

      try {
        const to = String(url.searchParams.get("to") || "").trim();
        const yearParam = url.searchParams.get("year");

        const now = new Date();
        const year = Number(yearParam ?? now.getUTCFullYear());

        const result = await emailFinalReceiptsZip({
          to: to || undefined,
          year,
          requestId,
        });

        if (result && result.ok) return !!REQ_OK(res, { requestId, ...result });
        return !!REQ_ERR(res, 500, (result && result.error) || "zip-send-failed", {
          requestId,
          ...(result || {}),
        });
      } catch (e) {
        return !!errResponse(res, 500, "receipts-zip-final-failed", req, e);
      }
    }

    if (type === "receipts_zip_month_auto") {
      if (!(await requireAdminAuth(req, res))) return true;

      try {
        const to = String(url.searchParams.get("to") || "").trim();
        const now = new Date();

        let y = now.getUTCFullYear();
        let m = now.getUTCMonth() + 1;
        m -= 1;
        if (m <= 0) {
          m = 12;
          y -= 1;
        }

        const result = await emailMonthlyReceiptsZip({
          to: to || undefined,
          year: y,
          month: m,
          requestId,
          auto: true,
        });

        if (result && result.ok) return !!REQ_OK(res, { requestId, ...result });
        return !!REQ_ERR(res, 500, (result && result.error) || "zip-send-failed", {
          requestId,
          ...(result || {}),
        });
      } catch (e) {
        return !!errResponse(res, 500, "receipts-zip-auto-failed", req, e);
      }
    }
  }

  if (req.method === "POST") {
    if (action === "set_receipts_zip_prefs") {
      if (!(await requireAdminAuth(req, res))) return true;

      const monthly = !!body?.monthly;
      const weekly = !!body?.weekly;
      const channel = body?.channel ? String(body.channel) : undefined;

      const next = await setReportingPrefs({
        receiptZip: { monthly, weekly },
        ...(channel ? { channel } : {}),
      });

      return !!REQ_OK(res, { requestId, ok: true, prefs: next });
    }
  }

  return false;
}
