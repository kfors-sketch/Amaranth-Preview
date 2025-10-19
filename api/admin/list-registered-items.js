// /api/admin/list-registered-items.js
import { loadAllItemConfigs } from "../../lib/item-configs.js";

export default async function handler(req, res){
  try{
    const cfgs = await loadAllItemConfigs();
    const items = cfgs.map(c => ({
      id: c.id,
      name: c.name,
      hasChairs: Array.isArray(c.chairEmails) && c.chairEmails.length > 0
    }));
    res.status(200).json({ items });
  }catch(e){
    console.error(e);
    res.status(200).json({ items: [] });
  }
}
