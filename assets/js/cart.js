<script>
// assets/js/cart.js
(function () {
  const LS_KEY = "cart_v1";

  // =========================
  // Bundle Pricing Registry
  // =========================
  // Configure deals by itemId: each entry is [{qty, totalCents}], largest-first greedy packing.
  // Example:
  // window.BUNDLE_PRICING = {
  //   "raffle-tickets": [
  //     { qty: 6, totalCents: 4000 },
  //     { qty: 3, totalCents: 2500 },
  //     { qty: 1, totalCents: 1000 }
  //   ]
  // };
  window.BUNDLE_PRICING = window.BUNDLE_PRICING || {};

  // =========================
  // Cart State
  // =========================
  // IMPORTANT: Internally store ALL prices in **DOLLARS** for UI friendliness.
  // (Router converts to cents when creating Stripe sessions.)
  const state = {
    attendees: [],  // [{id, displayName, notes, ...}]
    lines: [],      // [{id, attendeeId, itemType, itemId, itemName, qty, unitPrice(DOLLARS), meta, priceMode?}]
    updatedAt: Date.now()
  };

  function uid(prefix = "id") { return prefix + "_" + Math.random().toString(36).slice(2, 9); }

  // =========================
  // Price helpers
  // =========================
  // Normalize a price to **DOLLARS**:
  // - 0 < n < 1 → assume user accidentally sent "cents as decimal" (0.25) => 25 (dollars) ? Nope, that'd be wrong.
  // We only need to defend against raw cents mistakenly passed in.
  // Strategy:
  //   - If n >= 1000, it's almost certainly cents. Convert to dollars.
  //   - Else, treat as dollars as-is.
  function normalizeDollars(n) {
    const v = Number(n || 0);
    if (!isFinite(v) || v <= 0) return 0;
    // Heuristic: values >= 1000 are likely cents; convert to dollars.
    return (v >= 1000) ? Math.round(v) / 100 : v;
  }

  // Convert cents→dollars
  function centsToDollars(c) {
    const v = Number(c || 0);
    return Math.round(v) / 100;
  }

  // =========================
  // Persistence
  // =========================
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Guard: if older entries had cents, coerce them to dollars for display
        if (Array.isArray(parsed.lines)) {
          parsed.lines = parsed.lines.map(l => ({
            ...l,
            unitPrice: normalizeDollars(l.unitPrice)
          }));
        }
        Object.assign(state, parsed);
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    state.updatedAt = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("cart:updated", { detail: summary() }));
  }

  // =========================
  // Attendees
  // =========================
  function addAttendee(a) {
    const id = uid("att");
    state.attendees.push({ id, ...a });
    save();
    return id;
  }

  function updateAttendee(id, patch) {
    const i = state.attendees.findIndex(x => x.id === id);
    if (i >= 0) { state.attendees[i] = { ...state.attendees[i], ...patch }; save(); }
  }

  function removeAttendee(id) {
    state.attendees = state.attendees.filter(a => a.id !== id);
    state.lines = state.lines.filter(l => l.attendeeId !== id);
    save();
  }

  // =========================
  // Bundle logic (store dollars)
  // =========================
  function getBundlesFor(itemId) {
    const arr = Array.isArray(window.BUNDLE_PRICING[itemId]) ? [...window.BUNDLE_PRICING[itemId]] : [];
    arr.sort((a, b) => b.qty - a.qty); // largest-first
    return arr;
  }

  // Decompose qty into bundle parts; returns { parts, remainder }
  // parts: [{ label, qty:1, totalDollars, bundleQty }]
  // remainder: { units, unitDollars }
  function decomposeIntoBundles(itemId, qty, unitDollars) {
    const bundles = getBundlesFor(itemId);
    const parts = [];
    let remain = Number(qty || 0);

    if (remain <= 0 || bundles.length === 0) {
      return { parts: [], remainder: { units: remain, unitDollars } };
    }

    for (const b of bundles) {
      if (!b || !b.qty || !b.totalCents) continue;
      const count = Math.floor(remain / b.qty);
      if (count > 0) {
        const totalDollars = centsToDollars(b.totalCents);
        for (let i = 0; i < count; i++) {
          parts.push({
            label: `Bundle (${b.qty})`,
            qty: 1,
            totalDollars,
            bundleQty: b.qty
          });
        }
        remain -= count * b.qty;
      }
    }

    return { parts, remainder: { units: remain, unitDollars } };
  }

  // =========================
  // Line helpers
  // =========================
  function findMergeCandidate({ attendeeId, itemId, unitPrice, itemType, label }) {
    return state.lines.find(l =>
      l.attendeeId === attendeeId &&
      l.itemId === itemId &&
      Number(l.unitPrice) === Number(unitPrice) &&
      (l.itemType || "product") === (itemType || "product") &&
      (l.meta?.bundleLabel || "") === (label || "")
    );
  }

  function pushOrMergeLine(base) {
    const merged = findMergeCandidate(base);
    if (merged) {
      merged.qty += Number(base.qty || 0);
    } else {
      state.lines.push({
        id: uid("ln"),
        attendeeId: base.attendeeId || "",
        itemType: base.itemType || "product",
        itemId: base.itemId || "",
        itemName: base.itemName || "Item",
        qty: Number(base.qty || 1),
        unitPrice: normalizeDollars(base.unitPrice), // store dollars
        meta: base.meta || {},
        priceMode: base.priceMode || undefined
      });
    }
  }

  // =========================
  // Public add/update/remove
  // =========================
  function addProductLine(opts) {
    const {
      attendeeId = "",
      itemId = "",
      itemName = "Item",
      qty = 1,
      unitPrice = 0,
      meta = {}
    } = opts || {};

    const unitDollars = normalizeDollars(unitPrice);
    const nQty = Number(qty || 1);

    // Apply bundle breakdown
    const { parts, remainder } = decomposeIntoBundles(itemId, nQty, unitDollars);

    // Bundle parts as single fixed-price lines (each qty=1 with price = bundle total dollars)
    for (const p of parts) {
      pushOrMergeLine({
        attendeeId,
        itemType: "product",
        itemId,
        itemName: `${itemName} — ${p.label}`,
        qty: 1,
        unitPrice: p.totalDollars,
        meta: { ...meta, bundleLabel: p.label },
        priceMode: "bundle"
      });
    }

    // Remainder as normal per-unit lines in dollars
    if (remainder.units > 0) {
      pushOrMergeLine({
        attendeeId,
        itemType: "product",
        itemId,
        itemName,
        qty: remainder.units,
        unitPrice: remainder.unitDollars,
        meta
      });
    }

    save();
  }

  function addAddonLine(att, addon, note = "") {
    const attendeeId = typeof att === "string" ? att : (att?.id || "");
    const attendeeName = (typeof att === "object" && att) ? (att.displayName || att.name || "") : "";
    const unitDollars = normalizeDollars(addon.price);

    pushOrMergeLine({
      attendeeId,
      itemType: "addon",
      itemId: addon.id,
      itemName: addon.name,
      qty: 1,
      unitPrice: unitDollars,
      meta: {
        itemNote: note || "",
        attendeeName,
        attendeeNotes: (typeof att === "object" && att) ? (att.notes || "") : ""
      }
    });

    save();
  }

  function addBanquetLine(att, banquet, note = "") {
    const attendeeId = typeof att === "string" ? att : (att?.id || "");
    const attendeeName = (typeof att === "object" && att) ? (att.displayName || att.name || "") : "";
    const unitDollars = normalizeDollars(banquet.price);

    pushOrMergeLine({
      attendeeId,
      itemType: "banquet",
      itemId: banquet.id,
      itemName: banquet.name,
      qty: 1,
      unitPrice: unitDollars,
      meta: {
        itemNote: note || "",
        attendeeName,
        attendeeNotes: (typeof att === "object" && att) ? (att.notes || "") : ""
      }
    });

    save();
  }

  // Back-compat API
  function addLine({ attendeeId, itemType, itemId, itemName, qty, unitPrice, meta = {} }) {
    if ((itemType || "product") === "product") {
      return addProductLine({ attendeeId, itemId, itemName, qty, unitPrice, meta });
    }
    pushOrMergeLine({
      attendeeId,
      itemType: itemType || "product",
      itemId,
      itemName,
      qty: Number(qty || 1),
      unitPrice: normalizeDollars(unitPrice),
      meta
    });
    save();
  }

  function updateLine(id, patch) {
    const i = state.lines.findIndex(l => l.id === id);
    if (i >= 0) {
      const next = { ...state.lines[i], ...patch };
      if ("unitPrice" in patch) next.unitPrice = normalizeDollars(next.unitPrice);
      if ("qty" in patch) next.qty = Number(next.qty || 0);
      state.lines[i] = next;
      save();
    }
  }

  function removeLine(id) {
    state.lines = state.lines.filter(l => l.id !== id);
    save();
  }

  function clear() { state.attendees = []; state.lines = []; save(); }
  function get() { return JSON.parse(JSON.stringify(state)); }

  // =========================
  // Totals / Summary  (in dollars)
  // =========================
  function totals() {
    const subtotal = state.lines.reduce((s, l) => s + Number(l.unitPrice || 0) * Number(l.qty || 0), 0);
    const pct  = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feePercent || 0)) || 0;
    const flat = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feeFlat || 0)) || 0; // dollars
    const fee  = subtotal > 0 ? Math.round((subtotal * (pct / 100) + flat) * 100) / 100 : 0;
    const total = Math.round((subtotal + fee) * 100) / 100;
    return { subtotal, fee, total, pct, flat };
  }

  function summary() { return { ...get(), ...totals() }; }

  // =========================
  // Checkout payload helper
  // =========================
  // Build the lines for /api/router?action=create_checkout_session
  // We still send **dollars** here — the server uses toCentsAuto() safely.
  function buildCheckoutLines() {
    return state.lines.map(l => ({
      itemId: l.itemId,
      itemType: l.itemType || "product",
      itemName: l.itemName,
      qty: Number(l.qty || 1),
      unitPrice: Number(l.unitPrice || 0), // dollars
      attendeeId: l.attendeeId || "",
      meta: l.meta || {}
    }));
  }

  // Expose API
  window.Cart = {
    // state
    load, save, get, clear,
    // attendees
    addAttendee, updateAttendee, removeAttendee,
    // lines
    addLine, addProductLine, addAddonLine, addBanquetLine, updateLine, removeLine,
    // totals
    totals, summary,
    // checkout
    buildCheckoutLines,
    // config
    LS_KEY
  };
})();
</script>