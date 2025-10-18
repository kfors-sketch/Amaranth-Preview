// /assets/js/cart.js
(function(){
  const LS_KEY = "cart_v1";

  const state = {
    attendees: [], // {id, name, email, title}
    lines: [],     // {id, attendeeId, itemType, itemId, itemName, qty, unitPrice, meta:{}}
    updatedAt: Date.now()
  };

  function uid(prefix="id"){ return prefix + "_" + Math.random().toString(36).slice(2,9); }

  // Treat 0<n<1 as "cents accidentally stored as dollars"
  function normalizePrice(p){
    const n = Number(p);
    if (!isFinite(n) || isNaN(n)) return 0;
    return (n > 0 && n < 1) ? Math.round(n * 100) : n;
  }

  function load(){
    try {
      const raw = localStorage.getItem(LS_KEY);
      if(raw){
        const parsed = JSON.parse(raw);
        Object.assign(state, parsed);
      }
      // --- One-time migration: convert legacy cents to dollars
      let changed = false;
      (state.lines || []).forEach(l => {
        const n = Number(l.unitPrice);
        if (isFinite(n) && n > 0 && n < 1){
          l.unitPrice = Math.round(n * 100);
          changed = true;
        }
      });
      if (changed) save(); // persist the fixed amounts
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
    if(i>=0){
      state.attendees[i] = {...state.attendees[i], ...patch};
      save();
    }
  }

  function removeAttendee(id){
    state.attendees = state.attendees.filter(a=>a.id!==id);
    state.lines = state.lines.filter(l=>l.attendeeId!==id);
    save();
  }

  function addLine({attendeeId, itemType, itemId, itemName, qty, unitPrice, meta={}}){
    const cleanPrice = normalizePrice(unitPrice);
    const cleanQty = Number(qty) || 1;

    // Merge if same attendee + item id + unitPrice
    const existing = state.lines.find(l =>
      l.attendeeId===attendeeId && l.itemId===itemId && normalizePrice(l.unitPrice)===cleanPrice
    );

    if(existing){
      existing.qty += cleanQty;
    } else {
      state.lines.push({
        id: uid("ln"),
        attendeeId,
        itemType,
        itemId,
        itemName,
        qty: cleanQty,
        unitPrice: cleanPrice,
        meta
      });
    }
    save();
  }

  function updateLine(id, patch){
    const i = state.lines.findIndex(l=>l.id===id);
    if(i>=0){
      const np = (patch && Object.prototype.hasOwnProperty.call(patch, "unitPrice"))
        ? normalizePrice(patch.unitPrice)
        : undefined;

      state.lines[i] = {
        ...state.lines[i],
        ...patch,
        ...(np !== undefined ? { unitPrice: np } : {})
      };
      save();
    }
  }

  function removeLine(id){
    state.lines = state.lines.filter(l=>l.id!==id);
    save();
  }

  function clear(){
    state.attendees=[];
    state.lines=[];
    save();
  }

  function get(){
    // return a deep-ish copy
    return JSON.parse(JSON.stringify(state));
  }

  function totals(){
    const subtotal = state.lines.reduce((s,l)=> s + normalizePrice(l.unitPrice) * Number(l.qty||0), 0);
    const pct = (window.SITE_SETTINGS && window.SITE_SETTINGS.feePercent) || 0;
    const flat = (window.SITE_SETTINGS && window.SITE_SETTINGS.feeFlat) || 0;
    const fee = subtotal > 0 ? (subtotal * (pct/100) + flat) : 0;
    const total = subtotal + fee;
    return {subtotal, fee, total, pct, flat};
  }

  function summary(){
    const t = totals();
    return { ...get(), ...t };
  }

  // Expose globally
  window.Cart = {
    load, save, get,
    addAttendee, updateAttendee, removeAttendee,
    addLine, updateLine, removeLine, clear,
    totals, summary, LS_KEY
  };
})();
