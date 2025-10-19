// /api/admin/register-item.js
import { kv } from "@vercel/kv";

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).end();
    const { id, name, chairEmails, publishStart, publishEnd } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: "id and name required" });

    const cfg = {
      id,
      name,
      chairEmails: (Array.isArray(chairEmails) ? chairEmails : []).filter(Boolean),
      publishStart: publishStart || "",
      publishEnd: publishEnd || "",
      updatedAt: new Date().toISOString()
    };

    await kv.hset(`itemcfg:${id}`, cfg);
    await kv.sadd("itemcfg:index", id);

    res.status(200).json({ ok: true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "register-failed" });
  }
}
