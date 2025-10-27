// /api/router.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const REQ_OK = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });

// Simple bearer auth for admin writes
function requireToken(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== (process.env.REPORT_TOKEN || "")) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }
  return true;
}

async function kvGetSafe(key, fallback = null) {
  try { return await kv.get(key); } catch { return fallback; }
}
async function kvHsetSafe(key, obj) {
  try { await kv.hset(key, obj); return true; } catch { return false; }
}
async function kvSaddSafe(key, val) {
  try { await kv.sadd(key, val); return true; } catch { return false; }
}
async function kvSetSafe(key, val) {
  try { await kv.set(key, val); return true; } catch { return false; }
}
async function kvHgetallSafe(key) {
  try { return (await kv.hgetall(key)) || {}; } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get("action");   // POST mutations
    const type   = url.searchParams.get("type");     // GET reads

    // ---------- READS ----------
    if (req.method === "GET") {
      if (type === "banquets") {
        // Try KV; if not there, return empty array (client will fallback to /assets/js/banquets.js)
        const banquets = (await kvGetSafe("banquets")) || [];
        return REQ_OK(res, { banquets });
      }

      if (type === "addons") {
        const addons = (await kvGetSafe("addons")) || [];
        return REQ_OK(res, { addons });
      }

      if (type === "products") {
        const products = (await kvGetSafe("products")) || [];
        return REQ_OK(res, { products });
      }

      if (type === "settings") {
        const overrides = await kvHgetallSafe("settings:overrides");
        const env = {
          RESEND_FROM: process.env.RESEND_FROM || "",
          REPORTS_CC: process.env.REPORTS_CC || "",
          MAINTENANCE_ON: process.env.MAINTENANCE_ON === "true",
          MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || ""
        };
        const effective = {
          ...env,
          ...overrides,
          MAINTENANCE_ON: String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true"
        };
        return REQ_OK(res, { env, overrides, effective });
      }

      if (type === "send-test") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured");
        const to = url.searchParams.get("to") || process.env.REPORTS_CC || "";
        if (!to) return REQ_ERR(res, 400, "missing-to");
        await resend.emails.send({
          from: process.env.RESEND_FROM,
          to,
          subject: "Amaranth Reports — Test",
          text: "This is a test email to confirm deliverability."
        });
        return REQ_OK(res, { ok: true });
      }

      return REQ_ERR(res, 400, "unknown-type");
    }

    // ---------- WRITES ----------
    if (req.method === "POST") {
      if (!requireToken(req, res)) return;

      const body = req.body || {};

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets) ? body.banquets : [];
        await kvSetSafe("banquets", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_addons") {
        const list = Array.isArray(body.addons) ? body.addons : [];
        await kvSetSafe("addons", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_products") {
        const list = Array.isArray(body.products) ? body.products : [];
        await kvSetSafe("products", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_settings") {
        const allow = {};
        ["RESEND_FROM","REPORTS_CC","MAINTENANCE_ON","MAINTENANCE_MESSAGE"]
          .forEach(k => { if (k in body) allow[k] = body[k]; });
        if ("MAINTENANCE_ON" in allow) allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
        if (Object.keys(allow).length) await kvHsetSafe("settings:overrides", allow);
        return REQ_OK(res, { ok: true, overrides: allow });
      }

      if (action === "register_item") {
        // tolerate KV failures; never 500
        const { id, name, chairEmails = [], publishStart = "", publishEnd = "" } = body;
        if (!id || !name) return REQ_ERR(res, 400, "id-and-name-required");
        const cfg = {
          id, name,
          chairEmails: (Array.isArray(chairEmails) ? chairEmails : []).filter(Boolean),
          publishStart, publishEnd,
          updatedAt: new Date().toISOString()
        };
        const ok1 = await kvHsetSafe(`itemcfg:${id}`, cfg);
        const ok2 = await kvSaddSafe("itemcfg:index", id);
        if (!ok1 || !ok2) {
          // still succeed so the client/UI doesn't error
          return REQ_OK(res, { ok: true, warning: "kv-unavailable" });
        }
        return REQ_OK(res, { ok: true });
      }

      if (action === "send_report") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured");
        const { to = [], subject = "Amaranth Report", csv = "" } = body;
        if (!to.length) return REQ_ERR(res, 400, "missing-recipients");
        const attachment = [{
          filename: "report.csv",
          content: Buffer.from(csv).toString("base64"),
          encoding: "base64"
        }];
        await resend.emails.send({
          from: process.env.RESEND_FROM,
          to,
          cc: (process.env.REPORTS_CC || "").split(",").map(s=>s.trim()).filter(Boolean),
          subject,
          text: "Attached is your report.",
          attachments: attachment
        });
        return REQ_OK(res, { ok: true });
      }

      return REQ_ERR(res, 400, "unknown-action");
    }

    return REQ_ERR(res, 405, "method-not-allowed");
  } catch (e) {
    console.error(e);
    return REQ_ERR(res, 500, "router-failed");
  }
}
