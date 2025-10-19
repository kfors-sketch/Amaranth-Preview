// /api/admin/send-month-to-date.js
import { kv } from "@vercel/kv";
import { Resend } from "resend";
import { loadItemConfig, lineMatchesConfig } from "../../lib/item-configs.js";
import { rowsToCSV } from "../../lib/csv.js";

const resend = new Resend(process.env.RESEND_API_KEY);

async function loadOrdersForMonth(yyyymm) {
  const ids = await kv.smembers(`orders:${yyyymm}`);
  if (!ids?.length) return [];
  const results = await Promise.all(ids.map(id => kv.hgetall(`order:${id}`)));
  return results.filter(Boolean);
}

export default async function handler(req, res){
  try{
    const { itemId, to } = req.query;
    if (!itemId) return res.status(400).json({ error: "itemId required" });

    const cfg = await loadItemConfig(itemId);
    if (!cfg) return res.status(404).json({ error: "Unknown itemId" });

    // Compute current yyyymm and month start (UTC)
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth()+1).padStart(2,"0");
    const yyyymm = `${y}-${m}`;
    const monthStart = new Date(Date.UTC(y, now.getUTCMonth(), 1, 0, 0, 0));

    const orders = await loadOrdersForMonth(yyyymm);
    const headers = ["OrderID","PaidAt","Purchaser","Attendee","ItemID","Item","Qty","Unit","LineTotal"];
    const rows = [];

    for (const o of orders) {
      const paidAt = o?.paidAtISO ? new Date(o.paidAtISO) : null;
      if (paidAt && paidAt < monthStart) continue;    // safety (shouldn't happen)
      if (paidAt && paidAt > now) continue;           // only up to "now"

      const purchaser = o?.purchaser?.name || "";
      const attendees = (o?.attendees?.length ? o.attendees.map(a=>a.name||"") : [""]);
      for (const l of (o.lines || [])) {
        const lid = l.itemId || l.itemName || "unknown";
        if (!lineMatchesConfig(lid, itemId)) continue;
        const unit = Number(l.unitCents||0)/100;
        const lineTotal = (Number(l.qty||0)*Number(l.unitCents||0))/100;
        for (const an of attendees) {
          rows.push([
            o.orderId, o.paidAtISO||"", purchaser, an,
            lid, l.itemName||"", String(l.qty||0),
            unit.toFixed(2), lineTotal.toFixed(2)
          ]);
        }
      }
    }

    const csv = rowsToCSV(headers, rows);
    const recipients = to
      ? to.split(",").map(s=>s.trim()).filter(Boolean)
      : (Array.isArray(cfg.chairEmails) && cfg.chairEmails.length ? cfg.chairEmails : [process.env.ADMIN_CC_EMAIL]);

    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: recipients,
      cc: [process.env.ADMIN_CC_EMAIL],
      subject: `Month-to-Date Orders – ${cfg.name} (${yyyymm})`,
      text: `Attached is the month-to-date CSV for ${cfg.name} (from the 1st of ${yyyymm} through now).`,
      attachments: [{ filename: `${itemId}_${yyyymm}_MTD.csv`, content: Buffer.from(csv).toString("base64") }]
    });

    res.status(200).json({ ok:true, sentTo: recipients });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "send-mtd-failed" });
  }
}
