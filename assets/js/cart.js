
(function(){
  const LS_KEY = "cart_v1";
  const state = {
    attendees: [], // {id, name, email, title}
    lines: [],     // {id, attendeeId, itemType, itemId, itemName, qty, unitPrice, meta:{}}
    updatedAt: Date.now()
  };
  function uid(prefix="id"){ return prefix + "_" + Math.random().toString(36).slice(2,9); }
  function load(){
    try {
      const raw = localStorage.getItem(LS_KEY);
      if(raw){
        const parsed = JSON.parse(raw);
        Object.assign(state, parsed);
      }
    }catch(e){}
  }
  function save(){
    state.updatedAt = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("cart:updated", {detail: summary()}));
  }
  function addAttendee(a){
    const id = uid("att");
    state.attendees.push({id, ...a});
    save();
    return id;
  }
  function updateAttendee(id, patch){
    const i = state.attendees.findIndex(x=>x.id===id);
    if(i>=0){ state.attendees[i] = {...state.attendees[i], ...patch}; save(); }
  }
  function removeAttendee(id){
    state.attendees = state.attendees.filter(a=>a.id!==id);
    state.lines = state.lines.filter(l=>l.attendeeId!==id);
    save();
  }
  function addLine({attendeeId, itemType, itemId, itemName, qty, unitPrice, meta={}}){
    // Merge if same attendee + item id + unitPrice
    const existing = state.lines.find(l=>l.attendeeId===attendeeId && l.itemId===itemId && l.unitPrice===unitPrice);
    if(existing){ existing.qty += qty; } else { state.lines.push({id: uid("ln"), attendeeId, itemType, itemId, itemName, qty, unitPrice, meta}); }
    save();
  }
  function updateLine(id, patch){
    const i = state.lines.findIndex(l=>l.id===id);
    if(i>=0){ state.lines[i] = {...state.lines[i], ...patch}; save(); }
  }
  function removeLine(id){
    state.lines = state.lines.filter(l=>l.id!==id); save();
  }
  function clear(){ state.attendees=[]; state.lines=[]; save(); }
  function get(){ return JSON.parse(JSON.stringify(state)); }

  function totals(){
    const subtotal = state.lines.reduce((s,l)=> s + l.unitPrice * l.qty, 0);
    const pct = (window.SITE_SETTINGS && window.SITE_SETTINGS.feePercent) || 0;
    const flat = (window.SITE_SETTINGS && window.SITE_SETTINGS.feeFlat) || 0;
    const fee = subtotal > 0 ? (subtotal * (pct/100) + flat) : 0;
    const total = subtotal + fee;
    return {subtotal, fee, total, pct, flat};
  }

  // Orderer info
  function setOrderer(info){
    state.meta = state.meta || {};
    state.meta.orderer = {...(state.meta.orderer||{}), ...info};
    save();
  }
  function getOrderer(){
    return (state.meta && state.meta.orderer) ? {...state.meta.orderer} : {};
  }

  function summary(){
    const t = totals();
    return { ...get(), ...t };
  }

  // Expose globally
  window.Cart = { load, save, get, addAttendee, updateAttendee, removeAttendee, addLine, updateLine, removeLine, clear, totals, summary, setOrderer, getOrderer, LS_KEY };
})();
