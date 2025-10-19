// /api/cron/closing.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";
import { loadAllItemConfigs, lineMatchesConfig } from "../../lib/item-configs.js";
import { rowsToCSV } from "../../lib/csv.js";

const resend = new Resend(process.env.RESEND_API_KEY);

async function loadAllOrders() {
  const ids = await kv.smembers("orders:all");
  if (!ids?.length) return [];
  const results = await Promise.all(ids.map(id => kv.hgetall(`order:${id}`)));
  return results.filter(Boolean);
}

export default async function handler(req, res) {
  try {
    const all = await loadAllOrders();
    const now = new Date();
    const cfgs = await loadAllItemConfigs();
    let sent = 0;

    for (const cfg of cfgs) {
      const end = cfg.publishEnd ? new Date(cfg.publishEnd) : null;
      if (!end || now < end) continue;

      const sentKey = `closing:sent:${cfg.id}`;
      const already = await kv.get(sentKey);
      if (already) continue;

      const headers = ["OrderID","PaidAt","Purchaser","Attendee","ItemID","Item","Qty","Unit","LineTotal"];
      const rows = [];
      for (const o of all) {
        const purchaser = o?.purchaser?.name || "";
        const attendees = (o?.attendees?.length ? o.attendees.map(a=>a.name||"") : [""]);
        for (const l of (o.lines||[])) {
          const lid = l.itemId || l.itemName || "unknown";
          if (!lineMatchesConfig(lid, cfg.id)) continue;
          const unit = Number(l.unitCents||0)/100;
          const lineTotal = (Number(l.qty||0)*Number(l.unitCents||0))/100;
          for (const an of attendees) {
            rows.push([o.orderId, o.paidAtISO||"", purchaser, an, lid, l.itemName||"", String(l.qty||0), unit.toFixed(2), lineTotal.toFixed(2)]);
          }
        }
      }

      const csv = rowsToCSV(headers, rows);
      const recipients = (cfg.chairEmails?.length ? cfg.chairEmails : [process.env.ADMIN_CC_EMAIL]);

      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: recipients,
        cc: [process.env.ADMIN_CC_EMAIL],
        subject: `FINAL Orders – ${cfg.name}`,
        text: `Attached is the final CSV for ${cfg.name}.`,
        attachments: [{ filename: `${cfg.id}_FINAL.csv`, content: Buffer.from(csv).toString("base64") }]
      });

      await kv.set(sentKey, new Date().toISOString());
      sent++;
    }

    res.status(200).json({ ok:true, sent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:"closing-failed" });
  }
}
