(function(){
  const KEY_ITEMS     = 'data_items_v1';
  const KEY_BANQUETS  = 'data_banquets_v1';
  const KEY_SETTINGS  = 'data_settings_v1';

  const read  = k => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch(e){ return null; } };
  const write = (k,o) => localStorage.setItem(k, JSON.stringify(o));

  function getSettings(){
    const def = window.SITE_SETTINGS || {};
    const o   = read(KEY_SETTINGS);
    return Object.assign({}, def, o || {});
  }
  function saveSettings(p){
    const cur = getSettings();
    const nxt = Object.assign({}, cur, p || {});
    write(KEY_SETTINGS, nxt);
    window.dispatchEvent(new CustomEvent('settings:updated', { detail: nxt }));
    return nxt;
  }

  function getItems(){
    const def = (window.CATALOG_ITEMS || []).slice();
    const o   = read(KEY_ITEMS);
    if (!o) return def;
    const by = Object.fromEntries(def.map(x => [x.id, x]));
    o.forEach(v => { by[v.id] = Object.assign({}, by[v.id] || {}, v); });
    return Object.values(by);
  }
  function saveItems(list){
    write(KEY_ITEMS, list);
    window.dispatchEvent(new CustomEvent('items:updated'));
  }

  function getBanquets(){
    const def = (window.BANQUETS || []).slice();
    const o   = read(KEY_BANQUETS);
    if (!o) return def;
    const by = Object.fromEntries(def.map(x => [x.id, x]));
    o.forEach(v => { by[v.id] = Object.assign({}, by[v.id] || {}, v); });
    return Object.values(by);
  }
  function saveBanquets(list){
    write(KEY_BANQUETS, list);
    window.dispatchEvent(new CustomEvent('banquets:updated'));
  }

  window.DataStore = { getSettings, saveSettings, getItems, saveItems, getBanquets, saveBanquets };
})();
