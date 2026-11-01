// /api/lib/http.js
import { REQ_ERR } from "../admin/core.js";

function getRequestId(req) {
  return (
    req?.headers?.["x-vercel-id"] ||
    req?.headers?.["x-request-id"] ||
    `local-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );
}

function errResponse(res, status, code, req, err, extra = {}) {
  const requestId = getRequestId(req);
  console.error(`[router] ${code} requestId=${requestId}`, err);
  return REQ_ERR(res, status, code, {
    requestId,
  });
}

// ============================================================================
// RAW BODY HELPERS (required for Stripe webhook signature verification)
// ============================================================================
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


// ============================================================================
// URL helper
// - Normalizes req.url into a full URL object.
// - Works in Vercel Node/Serverless where req.url is typically a path + query.
// ============================================================================
function getUrl(req) {
  const raw = (req && req.url) ? String(req.url) : "/";
  const host =
    (req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) ||
    "localhost";
  const proto =
    (req && req.headers && (req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"])) ||
    "https";
  try {
    return new URL(raw, `${proto}://${host}`);
  } catch {
    // Fallback: strip anything weird
    return new URL("/", `${proto}://${host}`);
  }
}


// ---- Admin auth helper ----


export {
  getRequestId,
  errResponse,
  readRawBody,
  readJsonBody,
  getUrl,
};
