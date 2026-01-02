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

  // ===========================================================================
  // API ERROR HELPERS (so UI never shows "[object Object]")
  // ===========================================================================
  function safeStringify(v){
    try {
      if (typeof v === "string") return v;
      if (v == null) return "";
      return JSON.stringify(v, null, 2);
    } catch {
      try { return String(v); } catch { return "Unknown error"; }
    }
  }

  // Human-friendly message builder for router-style errors:
  // { error: "...", message: "...", detail: "...", requestId: "..." }
  function explainApiError(payload){
    if (!payload) return "Unknown error";

    // Common shapes we’ve used:
    // - { error: "router-failed", message: "..." }
    // - { error: "stripe-not-configured" }
    // - { error: "...", detail: "..."}
    const msg =
      payload?.message ||
      payload?.detail ||
      payload?.error?.message ||
      payload?.error_description ||
      payload?.error ||
      payload?.code ||
      payload?.status ||
      null;

    const requestId =
      payload?.requestId ||
      payload?.request_id ||
      payload?.detail?.requestId ||
      payload?.detail?.request_id ||
      "";

    // If Stripe error object is present (sometimes we pass it through)
    const stripeType = payload?.stripe?.type || payload?.error?.stripe?.type || "";
    const stripeCode = payload?.stripe?.code || payload?.error?.stripe?.code || "";

    const parts = [];
    if (msg) parts.push(String(msg));
    if (stripeType || stripeCode) {
      parts.push(`Stripe: ${stripeType || ""}${stripeType && stripeCode ? " / " : ""}${stripeCode || ""}`);
    }
    if (requestId) parts.push(`requestId: ${requestId}`);

    // If we still couldn’t find a message, dump JSON
    if (!parts.length) parts.push(safeStringify(payload));
    return parts.join("\n");
  }

  // Read JSON safely even if server returns non-JSON error text
  async function readJsonSafe(response){
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { return { raw: text }; }
  }

  // === PHONE HELPERS (shared across all pages) ===
  function digitsOnly(s){
    return String(s || "").replace(/\D+/g, "");
  }

  function formatUS(d){
    if (d.length <= 3) return d;
    if (d.length <= 6) return d.slice(0, 3) + "-" + d.slice(3);
    return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6, 10);
  }

  // Normalize any phone value we store on attendees:
  // - Keep "+..." as-is for international
  // - For 10 digits, use xxx-xxx-xxxx
  // - Otherwise leave it mostly as typed
  function normalizePhoneValue(v){
    const raw = String(v || "").trim();
    if (!raw) return "";
    if (raw.startsWith("+")) return raw; // keep international formats

    const d = digitsOnly(raw);
    if (d.length === 10) {
      return formatUS(d);
    }
    // For anything else (short, long, weird), just return original text
    return raw;
  }

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


// === NOTE/CHOICE NORMALIZATION (for correct line separation + display) ===
function _normStr(v){
  return String(v == null ? "" : v).trim();
}
function _normLower(v){
  return _normStr(v).toLowerCase();
}
// For corsage & love gift lines, we preserve distinctions in meta so they don't merge.
function normalizeLineMeta(line){
  line.meta = line.meta || {};
  const m = line.meta;

  const id = _normLower(line.itemId || line.id || "");

  // ---- Corsage: capture selected option + note ----
  if (id === "corsage") {
    // Try many possible keys from UI pages
    const choice =
      m.corsageChoice ??
      m.corsageType ??
      m.choice ??
      m.selection ??
      m.option ??
      m.variant ??
      m.color ??
      m.style ??
      m.kind ??
      "";

    const note =
      m.itemNote ??
      m.corsageNote ??
      m.note ??
      m.notes ??
      m.message ??
      "";

    // Store canonical keys
    m.corsageChoice = _normStr(choice);
    m.itemNote = _normStr(note);

    // Helpful flag for display
    const c = _normLower(m.corsageChoice);
    m.corsageIsCustom = c.includes("custom") || c === "c" || c === "other" || c === "special";
  }

  // ---- Love Gift: capture message/note ----
  if (id === "love-gift" || id === "love_gift" || id === "love gift") {
    const note =
      m.itemNote ??
      m.note ??
      m.notes ??
      m.message ??
      "";
    m.itemNote = _normStr(note);
  }

  return line;
}

function lineMetaSignature(line){
  const m = (line && line.meta) ? line.meta : {};
  const id = _normLower(line?.itemId || line?.id || "");
  if (id === "corsage") {
    return JSON.stringify({
      choice: _normStr(m.corsageChoice),
      note: _normStr(m.itemNote)
    });
  }
  if (id === "love-gift" || id === "love_gift" || id === "love gift") {
    return JSON.stringify({
      note: _normStr(m.itemNote)
    });
  }
  return "";
}
// =======================================================================

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

    // Normalize any stored attendee phone numbers as well
    data.attendees.forEach(a => {
      if (a && typeof a === "object" && "phone" in a) {
        a.phone = normalizePhoneValue(a.phone);
      }
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
    const att = { id, ...a };

    if ("phone" in att) {
      att.phone = normalizePhoneValue(att.phone);
    }

    state.attendees.push(att);
    save();
    return id;
  }

  function updateAttendee(id, patch){
    const i = state.attendees.findIndex(x => x.id === id);
    if (i >= 0){
      const current = state.attendees[i];
      const next = { ...current, ...patch };

      if ("phone" in next) {
        next.phone = normalizePhoneValue(next.phone);
      }

      state.attendees[i] = next;
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

    // Normalize meta so corsage/love-gift lines remain distinct
    normalizeLineMeta(line);

    // Merge only if same attendeeId + itemId + unitPrice + bundle-ness
    const existing = state.lines.find(l =>
      l.attendeeId === line.attendeeId &&
      l.itemId     === line.itemId &&
      Number(l.unitPrice) === Number(line.unitPrice) &&
      Boolean(l.meta && (l.meta.isBundle || l.meta.bundle || l.meta.bundleQty)) === Boolean(line.meta && (line.meta.isBundle || line.meta.bundle || line.meta.bundleQty)) &&
      lineMetaSignature(l) === lineMetaSignature(line)
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

  // === SHIPPING (in dollars) ===
  // We charge shipping & handling ONCE per order,
  // using the highest shippingCents value from any catalog item in the cart.
  function computeShippingDollars(){
    const items = Array.isArray(window.CATALOG_ITEMS) ? window.CATALOG_ITEMS : [];
    if (!items.length) return 0;

    // Build a quick lookup of itemId -> shippingCents
    const shippingMap = {};
    items.forEach(it => {
      if (it && it.id) {
        const cents = Number(it.shippingCents || 0);
        if (cents > 0) {
          shippingMap[it.id] = cents;
        }
      }
    });

    let maxCents = 0;

    state.lines.forEach(line => {
      const itemId = line && line.itemId;
      if (!itemId) return;
      const cents = shippingMap[itemId] || 0;
      if (cents > maxCents) maxCents = cents;
    });

    return maxCents > 0 ? maxCents / 100 : 0; // convert to dollars
  }

  // === TOTALS (in dollars) ===
  function totals(){
    const subtotal = state.lines.reduce((s, l) => s + Number(l.unitPrice || 0) * Number(l.qty || 0), 0);

    // Shipping & handling once per order, using highest shippingCents
    const shipping = computeShippingDollars();

    // Fees come from global SITE_SETTINGS (dollars-based): feePercent and feeFlat
    const pct  = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feePercent)) || 0;
    const flat = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feeFlat)) || 0;

    const feeBase = subtotal; // keep existing behavior: fee based on items only
    const fee = feeBase > 0 ? (feeBase * (pct / 100) + flat) : 0;

    const total = subtotal + shipping + fee;
    return { subtotal, shipping, fee, total, pct, flat };
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
    LS_KEY,
    // expose phone helpers so all pages (order / banquets / addons / mobile) can reuse them
    phoneHelpers: {
      digitsOnly,
      formatUS,
      normalizePhoneValue
    },
    // NEW: expose api helpers so pages show real error messages
    apiHelpers: {
      safeStringify,
      explainApiError,
      readJsonSafe
    }
  };

  // auto-load once
  load();
})();