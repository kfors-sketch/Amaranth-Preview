// /api/admin/addons.js
import { createClient } from "redis";

const KEY = "addons:list";
const TOKEN = process.env.REPORT_TOKEN; // same token you already use

let r; async function redis(){ if(!r){ r=createClient({ url: process.env.REDIS_URL }); r.on("error",e=>console.error("[redis]",e)); await r.connect(); } return r; }

export default async function handler(req,res){
  if(req.method !== "POST"){ res.setHeader("Allow","POST"); return res.status(405).json({error:"method-not-allowed"}); }

  try{
    const auth = (req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
    if(!TOKEN || auth!==TOKEN) return res.status(401).json({error:"unauthorized"});

    const body = req.body || {};
    const list = Array.isArray(body.addons) ? body.addons : [];
    // basic sanitize
    for(const a of list){
      if(!a.id || !/^[a-z0-9-]+$/.test(a.id)) return res.status(400).json({error:`invalid id for addon`});
      if(a.price != null && isNaN(Number(a.price))) return res.status(400).json({error:`invalid price for ${a.id}`});
    }

    const client = await redis();
    await client.set(KEY, JSON.stringify(list));
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({ ok:true, count:list.length });
  }catch(e){
    console.error("[/api/admin/addons] err:", e);
    return res.status(500).json({ error:"internal-error" });
  }
}
