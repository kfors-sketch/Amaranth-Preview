// /api/admin/products.js
import { createClient } from "redis";
const KEY = "products:list";
const TOKEN = process.env.REPORT_TOKEN;

let r; async function redis(){ if(!r){ r=createClient({ url: process.env.REDIS_URL }); r.on("error",e=>console.error("[redis]",e)); await r.connect(); } return r; }

export default async function handler(req,res){
  if(req.method!=="POST"){ res.setHeader("Allow","POST"); return res.status(405).json({error:"method-not-allowed"}); }

  try{
    const auth = (req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
    if(!TOKEN || auth!==TOKEN) return res.status(401).json({error:"unauthorized"});

    const list = Array.isArray(req.body?.products) ? req.body.products : [];
    for(const p of list){
      if(!p.id || !/^[a-z0-9-]+$/.test(p.id)) return res.status(400).json({error:`invalid id for product`});
      if(p.price != null && isNaN(Number(p.price))) return res.status(400).json({error:`invalid price for ${p.id}`});
      if(p.stock != null && isNaN(Number(p.stock))) return res.status(400).json({error:`invalid stock for ${p.id}`});
    }

    const client = await redis();
    await client.set(KEY, JSON.stringify(list));
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({ ok:true, count:list.length });
  }catch(e){
    console.error("[/api/admin/products] err:", e);
    return res.status(500).json({ error:"internal-error" });
  }
}
