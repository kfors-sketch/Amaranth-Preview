// /api/lib/auth.js
import { REQ_ERR } from "../admin/core.js";
import { getReportingPrefs, resolveChannel } from "../admin/report-channel.js";
import { verifyAdminToken } from "../admin/security.js";
import { getEffectiveOrderChannel } from "../admin/core.js";

async function requireAdminAuth(req, res) {
  const headers = req.headers || {};
  const rawAuth = headers.authorization || headers.Authorization || "";

  const auth = String(rawAuth || "");
  const lower = auth.toLowerCase();
  if (!lower.startsWith("bearer ")) {
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

async function getEffectiveReportMode() {
  const prefs = await getReportingPrefs();
  const isProduction =
    String(process.env.VERCEL_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const mode = resolveChannel({ requested: prefs.channel, isProduction });
  return { prefs, mode };
}




export {
  requireAdminAuth,
  getEffectiveReportMode,
};
