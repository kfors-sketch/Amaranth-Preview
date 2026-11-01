import { kvGetSafe, kvHgetallSafe } from "./kv.js";

// ----- Chair email resolution -----
async function getChairEmailsForItemId(id) {
  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  try {
    const banquets = await kvGetSafe("banquets", []);
    if (Array.isArray(banquets)) {
      const b = banquets.find((x) => String(x?.id || "") === String(id));
      if (b) {
        const arr = Array.isArray(b.chairEmails)
          ? b.chairEmails
          : safeSplit(b.chairEmails || b?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  try {
    const addons = await kvGetSafe("addons", []);
    if (Array.isArray(addons)) {
      const a = addons.find((x) => String(x?.id || "") === String(id));
      if (a) {
        const arr = Array.isArray(a.chairEmails)
          ? a.chairEmails
          : safeSplit(a.chairEmails || a?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  const cfg = await kvHgetallSafe(`itemcfg:${id}`);
  const legacyArr = Array.isArray(cfg?.chairEmails)
    ? cfg.chairEmails
    : safeSplit(cfg?.chairEmails || "");
  return legacyArr;
}


export { getChairEmailsForItemId };
