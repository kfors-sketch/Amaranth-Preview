// assets/js/cart.js
(function(){
  // bump key to force a clean read of the new structure while still migrating if found
  const LS_KEY = "cart_v2";

  const state = {
    attendees: [],
    lines: [],
    updatedAt: Date.now()
  };

  function uid(prefix="id"){ return prefix + "_" + Math.random().toString(36).slice(2,9); }

  // === PRICE RULES ===
  // We store ALL prices in **dollars** (e.g., 25, 40, 15.5). Never cents.
  // Router will convert to cents when creating Stripe line items.

  // Detect legacy values that were saved as cents (e.g., 2500 -> 25)
  function centsToDollarsIfNeeded(v){
    const n = Number(v || 0);
    if (!isFinite(n)) return 0;
    // If it's an integer >= 1000, assume it's cents from the v1 build and fix
    if (Number.isInteger(n) && Math.abs(n) >= 1000) return Math.round(n) / 100;
    return n;
  }

  // Normalize bundle info: if a line is marked bundle, force qty=1 and keep the given bundle price (in dollars)
  function normalizeBundle(line){
    const meta = line.meta || {};
    if (meta.isBundle || meta.bundle === true || (meta.bundleQty && meta.bundlePrice != null)) {
      // prefer explicit bundlePrice if provided, else keep unitPrice as-is
      if (meta.bundlePrice != null) {
        line.unitPrice = Number(meta.bundlePrice) || 0; // dollars
      }
      line.qty = 1; // bundles should remain single-line
    }
    return line;
  }

  // === STORAGE ===
  function load(){
    try {
      // Prefer v2; if not found, migrate from old v1 key
      const rawV2 = localStorage.getItem(LS_KEY);
      if (rawV2) {
        const parsed = JSON.parse(rawV2);
        migrateInPlace(parsed);
        Object.assign(state, parsed);
        return;
      }
      const rawV1 = localStorage.getItem("cart_v1");
      if (rawV1) {
        const parsed = JSON.parse(rawV1);
        migrateInPlace(parsed);
        Object.assign(state, parsed);
        // Save to v2 and also keep v1 around (non-destructive)
        localStorage.setItem(LS_KEY, JSON.stringify(state));
        return;
      }
    } catch(e){}
  }

  function migrateInPlace(data){
    if (!data || typeof data !== "object") return;
    data.attendees = Array.isArray(data.attendees) ? data.attendees : [];
    data.lines     = Array.isArray(data.lines) ? data.lines : [];
    data.updatedAt = data.updatedAt || Date.now();

    // Convert any cents numbers to dollars
    data.lines.forEach(l => {
      l.unitPrice = centsToDollarsIfNeeded(l.unitPrice);
      l.qty = Number(l.qty || 0);
      l.meta = l.meta || {};
      normalizeBundle(l);
    });
  }

  function save(){
    state.updatedAt = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("cart:updated", { detail: summary() }));
  }

  // === ATTENDEES ===
  function addAttendee(a){
    const id = uid("att");
    state.attendees.push({ id, ...a });
    save();
    return id;
  }

  function updateAttendee(id, patch){
    const i = state.attendees.findIndex(x => x.id === id);
    if (i >= 0){
      state.attendees[i] = { ...state.attendees[i], ...patch };
      save();
    }
  }

  function removeAttendee(id){
    state.attendees = state.attendees.filter(a => a.id !== id);
    state.lines     = state.lines.filter(l => l.attendeeId !== id);
    save();
  }

  // === LINES ===
  // Add a line in dollars. If it's a bundle, we force qty=1 and keep bundle price.
  function addLine({ attendeeId, itemType, itemId, itemName, qty, unitPrice, meta = {} }){
    const price = Number(unitPrice || 0);
    const line  = normalizeBundle({
      id: uid("ln"),
      attendeeId, itemType, itemId, itemName,
      qty: Number(qty || 1),
      unitPrice: price,
      meta
    });

    // Merge only if same attendeeId + itemId + unitPrice + bundle-ness
    const existing = state.lines.find(l =>
      l.attendeeId === line.attendeeId &&
      l.itemId     === line.itemId &&
      Number(l.unitPrice) === Number(line.unitPrice) &&
      Boolean(l.meta && (l.meta.isBundle || l.meta.bundle || l.meta.bundleQty)) === Boolean(line.meta && (line.meta.isBundle || line.meta.bundle || line.meta.bundleQty))
    );

    if (existing){
      // For bundles we still keep qty at 1; for normal items, sum qty
      if (line.meta && (line.meta.isBundle || line.meta.bundle || line.meta.bundleQty)) {
        existing.qty = 1; // one bundle line only
      } else {
        existing.qty += line.qty;
      }
    } else {
      state.lines.push(line);
    }
    save();
  }

  function updateLine(id, patch){
    const i = state.lines.findIndex(l => l.id === id);
    if (i >= 0){
      const next = { ...state.lines[i], ...patch };
      next.unitPrice = Number(next.unitPrice || 0); // dollars
      next.qty       = Number(next.qty || 0);
      normalizeBundle(next);
      state.lines[i] = next;
      save();
    }
  }

  function removeLine(id){
    state.lines = state.lines.filter(l => l.id !== id);
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

  // === TOTALS (in dollars) ===
  function totals(){
    const subtotal = state.lines.reduce((s, l) => s + Number(l.unitPrice || 0) * Number(l.qty || 0), 0);

    // Fees come from global SITE_SETTINGS (dollars-based): feePercent and feeFlat
    const pct  = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feePercent)) || 0;
    const flat = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feeFlat)) || 0;

    const fee = subtotal > 0 ? (subtotal * (pct / 100) + flat) : 0;
    const total = subtotal + fee;
    return { subtotal, fee, total, pct, flat };
  }

  function summary(){
    const t = totals();
    return { ...get(), ...t };
  }

  // expose API
  window.Cart = {
    load, save, get,
    addAttendee, updateAttendee, removeAttendee,
    addLine, updateLine, removeLine, clear,
    totals, summary,
    LS_KEY
  };

  // auto-load once
  load();
})();