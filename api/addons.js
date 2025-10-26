// /api/addons.js
import { createClient } from "redis";
const KEY = "addons:list";

let r; async function redis(){ if(!r){ r=createClient({ url: process.env.REDIS_URL }); r.on("error",e=>console.error("[redis]",e)); await r.connect(); } return r; }

export default async function handler(req,res){
  if(req.method!=="GET"){ res.setHeader("Allow","GET"); return res.status(405).json({error:"method-not-allowed"}); }
  try{
    const client = await redis();
    const raw = await client.get(KEY);
    if(!raw) return res.status(404).json({ error:"no-addons-stored" });
    const addons = JSON.parse(raw);
    if(!Array.isArray(addons)) return res.status(500).json({error:"invalid-format"});
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({ addons });
  }catch(e){
    console.error("[/api/addons] err:", e);
    return res.status(500).json({ error:"internal-error" });
  }
}
