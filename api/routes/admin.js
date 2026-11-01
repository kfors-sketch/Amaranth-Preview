// /api/routes/admin.js
//
// Admin route module for the split router.
//
// KEY FIX:
// - When we read the request body here, we MUST cache it on req._rawBodyBuffer
//   so the main router can continue when this module returns false.
//   Otherwise legacy sees an empty stream and returns {"error":"unknown-action"}.
//

import { kv } from "@vercel/kv";
import { verifyAdminToken } from "../admin/security.js";

const TOKEN_HEADER = "x-admin-token";
const ADMIN_PASSWORD_ENV = (process.env.ADMIN_PASSWORD || "").trim();
const KV_ADMIN_TOKEN_KEY = "admin:token";

// -------------------- body helpers (Node req) --------------------
async function readRawBody(req) {
  // Reuse if already read by legacy or another module
  if (req._rawBodyBuffer) return req._rawBodyBuffer;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);

  // ✅ Critical: cache for legacy fall-through
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
    const err = new Error("invalid-json");
    err.statusCode = 400;
    err.details = e?.message || String(e);
    throw err;
  }
}

// -------------------- admin auth --------------------
async function requireAdmin(req) {
  const headers = req?.headers || {};

  // 1) Bearer token (preferred; matches legacy)
  const rawAuth = headers.authorization || headers.Authorization || "";
  const auth = String(rawAuth || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (!token) {
      const err = new Error("unauthorized");
      err.statusCode = 401;
      throw err;
    }

    const legacy = (process.env.REPORT_TOKEN || "").trim();
    if (legacy && token === legacy) return;

    try {
      const result = await verifyAdminToken(token);
      if (result?.ok) return;
    } catch {
      // fall through
    }

    const err = new Error("unauthorized");
    err.statusCode = 401;
    throw err;
  }

  // 2) x-admin-token (front-end header)
  const token = String(headers[TOKEN_HEADER] || headers[TOKEN_HEADER.toLowerCase()] || "").trim();
  if (token) {
    const expected = (await kv.get(KV_ADMIN_TOKEN_KEY)) || "";
    if (expected && token === String(expected)) return;

    if (ADMIN_PASSWORD_ENV && token === ADMIN_PASSWORD_ENV) return;
  }

  const err = new Error("unauthorized");
  err.statusCode = 401;
  throw err;
}

export async function handleAdminGET(_req, _res) {
  return false;
}

export async function handleAdminPOST(req, res) {
  // Always parse once; body will be cached for legacy if we return false.
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e?.statusCode === 400 && e?.message === "invalid-json") {
      res.status(400).json({ ok: false, error: "invalid-json", details: e?.details || "" });
      return true;
    }
    return false;
  }

  const action = body?.action;
  if (!action) return false;

  try {
    if (action === "admin_ping") {
      res.status(200).json({ ok: true, msg: "admin.js is live (fallthrough-safe)" });
      return true;
    }

    if (action === "admin_purge_addons") {
      await requireAdmin(req);

      const ids = body?.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ ok: false, error: "Missing ids[]" });
        return true;
      }

      const years = ["2025", "2026", "2027", "2028"];

      for (const id of ids) {
        await kv.del(`itemcfg:${id}`);
        await kv.srem("itemcfg:index:addons", id);
        await kv.srem("itemcfg:index:all", id);

        for (const y of years) {
          await kv.srem(`itemcfg:index:addons:${y}`, id);
          await kv.srem(`itemcfg:index:all:${y}`, id);
          await kv.srem(`itemcfg:index:${y}:addons`, id);
          await kv.srem(`itemcfg:index:${y}:all`, id);
        }
      }

      res.status(200).json({ ok: true, purged: ids.length, ids });
      return true;
    }

    // Not handled here; legacy will handle using req._rawBodyBuffer
    return false;
  } catch (e) {
    const status = e?.statusCode || 500;
    res.status(status).json({ ok: false, error: String(e?.message || e) });
    return true;
  }
}
