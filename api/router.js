// /api/router.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const REQ_OK = (res, data) => res.status(200).json(data);
const REQ_ERR = (res, code, msg, extra={}) => res.status(code).json({ error: msg, ...extra });

// Simple bearer auth for admin writes
function requireToken(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== process.env.REPORT_TOKEN) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get("action");   // for POST "mutations"
    const type   = url.searchParams.get("type");     // for GET "reads"

    // ---------- READS (GET) ----------
    if (req.method === "GET") {
      if (type === "banquets") {
        // try KV first
        let banquets = (await kv.get("banquets")) || null;
        // fallback to static file if available
        if (!banquets) {
          const mod = await import("../../assets/js/banquets.js");
          banquets = mod?.BANQUETS || [];
        }
        return REQ_OK(res, { banquets });
      }

      if (type === "addons") {
        let addons = (await kv.get("addons")) || null;
        if (!addons) {
          const mod = await import("../../assets/js/addons.js");
          addons = mod?.ADDONS || [];
        }
        return REQ_OK(res, { addons });
      }

      if (type === "products") {
        let products = (await kv.get("products")) || null;
        if (!products) {
          const mod = await import("../../assets/js/products.js");
          products = mod?.PRODUCTS || [];
        }
        return REQ_OK(res, { products });
      }

      if (type === "settings") {
        // effective values (env + overrides)
        const overrides = (await kv.hgetall("settings:overrides")) || {};
        const env = {
          RESEND_FROM: process.env.RESEND_FROM || "",
          REPORTS_CC: process.env.REPORTS_CC || "",
          MAINTENANCE_ON: process.env.MAINTENANCE_ON === "true",
          MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || ""
        };
        const effective = {
          ...env,
          ...overrides,
          MAINTENANCE_ON:
            String(overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) === "true"
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

    // ---------- WRITES (POST) ----------
    if (req.method === "POST") {
      if (!requireToken(req, res)) return; // admin-only writes

      const body = req.body || {};

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets) ? body.banquets : [];
        await kv.set("banquets", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_addons") {
        const list = Array.isArray(body.addons) ? body.addons : [];
        await kv.set("addons", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_products") {
        const list = Array.isArray(body.products) ? body.products : [];
        await kv.set("products", list);
        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_settings") {
        const allow = {};
        ["RESEND_FROM","REPORTS_CC","MAINTENANCE_ON","MAINTENANCE_MESSAGE"]
          .forEach(k => { if (k in body) allow[k] = body[k]; });
        // coerce MAINTENANCE_ON to string "true"/"false"
        if ("MAINTENANCE_ON" in allow) allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
        if (Object.keys(allow).length) await kv.hset("settings:overrides", allow);
        return REQ_OK(res, { ok: true, overrides: allow });
      }

      if (action === "register_item") {
        const { id, name, chairEmails = [], publishStart = "", publishEnd = "" } = body;
        if (!id || !name) return REQ_ERR(res, 400, "id-and-name-required");
        const cfg = {
          id, name,
          chairEmails: chairEmails.filter(Boolean),
          publishStart, publishEnd,
          updatedAt: new Date().toISOString()
        };
        await kv.hset(`itemcfg:${id}`, cfg);
        await kv.sadd("itemcfg:index", id);
        return REQ_OK(res, { ok: true });
      }

      if (action === "send_report") {
        if (!resend) return REQ_ERR(res, 500, "resend-not-configured");
        const { to = [], subject = "Amaranth Report", csv = "" } = body;
        if (!to.length) return REQ_ERR(res, 400, "missing-recipients");
        const attachment = [
          {
            filename: "report.csv",
            content: Buffer.from(csv).toString("base64"),
            encoding: "base64"
          }
        ];
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
