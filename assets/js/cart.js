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
      if (raw) {
        const parsed = JSON.parse(raw);
        // Coerce numeric fields defensively on load
        if (Array.isArray(parsed.lines)) {
          parsed.lines.forEach(l=>{
            l.qty = Number(l.qty||0);
            l.unitPrice = Number(l.unitPrice||0);
          });
        }
        Object.assign(state, parsed);
      }
    }catch(e){}
  }

  function save(){
    state.updatedAt = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("cart:updated", { detail: summary() }));
  }

  function addAttendee(a){
    const id = uid("att");
    state.attendees.push({id, ...a});
    save();
    return id;
  }

  function updateAttendee(id, patch){
    const i = state.attendees.findIndex(x=>x.id===id);
    if (i>=0){ state.attendees[i] = {...state.attendees[i], ...patch}; save(); }
  }

  function removeAttendee(id){
    state.attendees = state.attendees.filter(a=>a.id!==id);
    state.lines = state.lines.filter(l=>l.attendeeId!==id);
    save();
  }

  // Helper: shallow meta compare for merging (so different mealChoice doesn't merge)
  function sameMeta(a={}, b={}) {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak){
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  function addLine({attendeeId, itemType, itemId, itemName, qty, unitPrice, meta={}}){
    const q = Number(qty||0);
    const up = Number(unitPrice||0);

    // Merge line items when they are truly the same item for the same attendee
    const existing = state.lines.find(l =>
      l.attendeeId === attendeeId &&
      l.itemId === itemId &&
      Number(l.unitPrice) === up &&
      l.itemType === itemType &&
      sameMeta(l.meta||{}, meta||{})
    );

    if (existing){
      existing.qty = Number(existing.qty||0) + q;
    } else {
      state.lines.push({
        id: uid("ln"),
        attendeeId,
        itemType,
        itemId,
        itemName,
        qty: q,
        unitPrice: up,
        meta
      });
    }
    save();
  }

  function updateLine(id, patch){
    const i = state.lines.findIndex(l=>l.id===id);
    if (i>=0){
      const cur = state.lines[i];
      state.lines[i] = {
        ...cur,
        ...patch,
        // Make sure numeric fields stay numeric
        qty: patch && "qty" in patch ? Number(patch.qty||0) : cur.qty,
        unitPrice: patch && "unitPrice" in patch ? Number(patch.unitPrice||0) : cur.unitPrice
      };
      save();
    }
  }

  function removeLine(id){
    state.lines = state.lines.filter(l=>l.id!==id);
    save();
  }

  function clear(){
    state.attendees = [];
    state.lines = [];
    save();
  }

  function get(){
    return JSON.parse(JSON.stringify(state));
  }

  function totals(){
    // All math in dollars
    const subtotal = state.lines.reduce((s,l)=> s + Number(l.unitPrice||0) * Number(l.qty||0), 0);
    const pct = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feePercent)) || 0;
    const flat = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feeFlat)) || 0; // <-- must be in dollars
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
