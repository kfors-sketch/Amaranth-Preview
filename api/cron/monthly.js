// /api/cron/monthly.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";
import { loadAllItemConfigs, lineMatchesConfig } from "../../lib/item-configs.js";
import { rowsToCSV } from "../../lib/csv.js";

const resend = new Resend(process.env.RESEND_API_KEY);

async function loadOrdersForMonth(yyyymm) {
  const ids = await kv.smembers(`orders:${yyyymm}`);
  if (!ids?.length) return [];
  const results = await Promise.all(ids.map(id => kv.hgetall(`order:${id}`)));
  return results.filter(Boolean);
}

export default async function handler(req, res) {
  try {
    // NEW: allow optional per-banquet run, e.g. /api/cron/monthly?banquetId=pa2026-chicken
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const onlyId = url.searchParams.get("banquetId"); // null or string

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth()+1).padStart(2,"0");
    const yyyymm = `${y}-${m}`;

    const orders = await loadOrdersForMonth(yyyymm);
    if (!orders.length) return res.status(200).json({ ok:true, info:"no-orders" });

    // Which base item ids appeared (normalize variant ids like "corsage:red")
    const presentBase = new Set();
    for (const o of orders) for (const l of (o.lines||[])) {
      const id = (l.itemId || "unknown").split(":")[0];
      presentBase.add(id);
    }

    const cfgs = await loadAllItemConfigs();
    let sent = 0;

    for (const cfg of cfgs) {
      // NEW: if a banquetId filter was provided, skip other configs
      if (onlyId && cfg.id !== onlyId) continue;

      if (!presentBase.has(cfg.id)) continue;

      const headers = ["OrderID","PaidAt","Purchaser","Attendee","ItemID","Item","Qty","Unit","LineTotal"];
      const rows = [];
      for (const o of orders) {
        const purchaser = o?.purchaser?.name || "";
        const attendees = (o?.attendees?.length ? o.attendees.map(a=>a.name||"") : [""]);
        for (const l of (o.lines || [])) {
          const lid = l.itemId || l.itemName || "unknown";
          if (!lineMatchesConfig(lid, cfg.id)) continue;
          const unit = Number(l.unitCents||0)/100;
          const lineTotal = (Number(l.qty||0)*Number(l.unitCents||0))/100;
          for (const an of attendees) {
            rows.push([
              o.orderId, o.paidAtISO||"", purchaser, an,
              lid, l.itemName||"", String(l.qty||0), unit.toFixed(2), lineTotal.toFixed(2)
            ]);
          }
        }
      }

      const csv = rowsToCSV(headers, rows);
      const recipients = (cfg.chairEmails?.length ? cfg.chairEmails : [process.env.ADMIN_CC_EMAIL]);

      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: recipients,
        cc: [process.env.ADMIN_CC_EMAIL],
        subject: `Monthly Orders – ${cfg.name} (${yyyymm})`,
        text: `Attached is the monthly CSV for ${cfg.name} (${yyyymm}).`,
        attachments: [{ filename: `${cfg.id}_${yyyymm}.csv`, content: Buffer.from(csv).toString("base64") }]
      });
      sent++;
    }

    res.status(200).json({ ok:true, sent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:"cron-failed" });
  }
}
