// /api/orders/save.js
import { kv } from "@vercel/kv";

// Expect a normalized payload like:
// {
//   orderId, paidAtISO,
//   purchaser: { name, email, phone, address{...} },
//   attendees: [{ id, name, email, title }],
//   lines: [{ itemId, itemName, qty, unitCents }]
// }
export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).end();
    const body = req.body || await readJson(req);

    if (!body?.orderId) return res.status(400).json({ error: "orderId required" });

    await kv.hset(`order:${body.orderId}`, body);
    await kv.sadd("orders:all", body.orderId);

    // also index by month (UTC)
    const d = body.paidAtISO ? new Date(body.paidAtISO) : new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2,"0");
    const yyyymm = `${y}-${m}`;
    await kv.sadd(`orders:${yyyymm}`, body.orderId);

    res.status(200).json({ ok: true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "save-failed" });
  }
}

async function readJson(req){
  return await new Promise((resolve, reject)=>{
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch(e){ reject(e); }
    });
    req.on("error", reject);
  });
}
