// /lib/item-configs.js
import { kv } from "@vercel/kv";

export async function loadAllItemConfigs(){
  const ids = await kv.smembers("itemcfg:index");
  if (!ids?.length) return [];
  const all = await Promise.all(ids.map(id => kv.hgetall(`itemcfg:${id}`)));
  return all.filter(Boolean);
}

export async function loadItemConfig(id){
  return await kv.hgetall(`itemcfg:${id}`);
}

// supports variant ids like "corsage:red-roses"
export function lineMatchesConfig(lineItemId, cfgId){
  return lineItemId === cfgId || lineItemId?.startsWith?.(`${cfgId}:`);
}
