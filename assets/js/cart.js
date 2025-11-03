// assets/js/cart.js
(function () {
  const LS_KEY = "cart_v1";

  // =========================
  // Bundle Pricing Registry
  // =========================
  // Configure bundle deals by itemId (stable id you use in your catalog).
  // Each entry is an array of {qty, totalCents}. Greedy largest-first will be applied.
  // Example for "raffle-tickets": 1 for $10, 3 for $25, 6 for $40
  window.BUNDLE_PRICING = window.BUNDLE_PRICING || {
    // "raffle-tickets": [
    //   { qty: 6, totalCents: 4000 },
    //   { qty: 3, totalCents: 2500 },
    //   { qty: 1, totalCents: 1000 }
    // ]
  };

  // If you prefer to set this on the page, do:
  // <script>window.BUNDLE_PRICING = { "raffle-tickets":[{qty:6,totalCents:4000},{qty:3,totalCents:2500},{qty:1,totalCents:1000}] };</script>

  // =========================
  // Cart State
  // =========================
  const state = {
    attendees: [],  // [{id, displayName, notes, ...}]
    lines: [],      // [{id, attendeeId, itemType, itemId, itemName, qty, unitPrice, meta, priceMode?}]
    updatedAt: Date.now()
  };

  function uid(prefix = "id") { return prefix + "_" + Math.random().toString(36).slice(2, 9); }

  // Normalize to "cents" semantics.
  // If it's obviously "cents" (>=1000) return as-is.
  // Otherwise treat as dollars and multiply by 100.
  function toCentsAuto(n) {
    const v = Number(n || 0);
    if (!isFinite(v)) return 0;
    return v < 1000 ? Math.round(v * 100) : Math.round(v);
  }

  // Back-compat: accept unitPrice that might be dollars or cents
  function normalizePrice(p) { return toCentsAuto(p); }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
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
    if (i >= 0) {
      state.attendees[i] = { ...state.attendees[i], ...patch };
      save();
    }
  }

  function removeAttendee(id) {
    state.attendees = state.attendees.filter(a => a.id !== id);
    state.lines = state.lines.filter(l => l.attendeeId !== id);
    save();
  }

  // =========================
  // Bundle logic
  // =========================

  function getBundlesFor(itemId) {
    const arr = Array.isArray(window.BUNDLE_PRICING[itemId]) ? [...window.BUNDLE_PRICING[itemId]] : [];
    // largest-first
    arr.sort((a, b) => b.qty - a.qty);
    return arr;
  }

  // Decompose qty into fixed-price bundle "virtual lines".
  // Returns an array of {label, qty, totalCents, bundleQty} (each represents one bundle group)
  // and a remainder {units, unitCents}
  function decomposeIntoBundles(itemId, qty, unitCents) {
    const bundles = getBundlesFor(itemId);
    const parts = [];
    let remain = Number(qty || 0);

    if (remain <= 0 || bundles.length === 0) {
      return { parts: [], remainder: { units: remain, unitCents } };
    }

    for (const b of bundles) {
      if (b.qty <= 0) continue;
      const count = Math.floor(remain / b.qty);
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          parts.push({
            label: `Bundle (${b.qty})`,
            qty: 1,
            totalCents: Number(b.totalCents || 0),
            bundleQty: b.qty
          });
        }
        remain -= count * b.qty;
      }
    }

    return { parts, remainder: { units: remain, unitCents } };
  }

  // =========================
  // Line helpers
  // =========================

  // Merge if same attendeeId + itemId + unitPrice + itemType + label (for bundle label)
  function findMergeCandidate({ attendeeId, itemId, unitPrice, itemType, label }) {
    return state.lines.find(l =>
      l.attendeeId === attendeeId &&
      l.itemId === itemId &&
      normalizePrice(l.unitPrice) === normalizePrice(unitPrice) &&
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
        unitPrice: normalizePrice(base.unitPrice),
        meta: base.meta || {},
        priceMode: base.priceMode || undefined // e.g., "bundle" for clarity
      });
    }
  }

  // =========================
  // Public add/update/remove
  // =========================

  /**
   * Add a product line (catalog). Will respect bundle pricing if configured.
   * @param {Object} opts
   *  - attendeeId?: string (optional; set if product belongs to an attendee)
   *  - itemId: string
   *  - itemName: string
   *  - qty: number
   *  - unitPrice: number (dollars or cents; auto-normalized)
   *  - meta?: object (e.g., { itemNote, attendeeName, attendeeNotes })
   */
  function addProductLine(opts) {
    const {
      attendeeId = "",
      itemId = "",
      itemName = "Item",
      qty = 1,
      unitPrice = 0,
      meta = {}
    } = opts || {};

    const unitCents = normalizePrice(unitPrice);
    const nQty = Number(qty || 1);

    // If a bundle is configured for this item, decompose into bundle parts
    const { parts, remainder } = decomposeIntoBundles(itemId, nQty, unitCents);

    // Push bundle parts as fixed-price lines (qty=1 with unitPrice = total bundle)
    for (const p of parts) {
      pushOrMergeLine({
        attendeeId,
        itemType: "product",
        itemId,
        itemName: `${itemName} — ${p.label}`,
        qty: 1,
        unitPrice: p.totalCents, // fixed single line with total
        meta: { ...meta, bundleLabel: p.label },
        priceMode: "bundle"
      });
    }

    // Push any remainder as normal per-unit lines
    if (remainder.units > 0) {
      pushOrMergeLine({
        attendeeId,
        itemType: "product",
        itemId,
        itemName,
        qty: remainder.units,
        unitPrice: remainder.unitCents,
        meta
      });
    }

    save();
  }

  /**
   * Add an ADD-ON line linked to a specific attendee.
   * This keeps add-ons grouped with the attendee in the email/receipt.
   */
  function addAddonLine(att, addon, note = "") {
    const attendeeId = typeof att === "string" ? att : (att?.id || "");
    const attendeeName = (typeof att === "object" && att) ? (att.displayName || att.name || "") : "";
    const unitCents = normalizePrice(addon.price);

    pushOrMergeLine({
      attendeeId,
      itemType: "addon",
      itemId: addon.id,
      itemName: addon.name,
      qty: 1,
      unitPrice: unitCents,
      meta: {
        itemNote: note || "",
        attendeeName,
        attendeeNotes: (typeof att === "object" && att) ? (att.notes || "") : ""
      }
    });

    save();
  }

  /**
   * Add a BANQUET line linked to a specific attendee.
   * (Same pattern as add-on; useful in your attendee UI.)
   */
  function addBanquetLine(att, banquet, note = "") {
    const attendeeId = typeof att === "string" ? att : (att?.id || "");
    const attendeeName = (typeof att === "object" && att) ? (att.displayName || att.name || "") : "";
    const unitCents = normalizePrice(banquet.price);

    pushOrMergeLine({
      attendeeId,
      itemType: "banquet",
      itemId: banquet.id,
      itemName: banquet.name,
      qty: 1,
      unitPrice: unitCents,
      meta: {
        itemNote: note || "",
        attendeeName,
        attendeeNotes: (typeof att === "object" && att) ? (att.notes || "") : ""
      }
    });

    save();
  }

  // Back-compat: the original API
  function addLine({ attendeeId, itemType, itemId, itemName, qty, unitPrice, meta = {} }) {
    if ((itemType || "product") === "product") {
      return addProductLine({ attendeeId, itemId, itemName, qty, unitPrice, meta });
    }
    // For addon/banquet, just push/merge
    pushOrMergeLine({
      attendeeId,
      itemType: itemType || "product",
      itemId,
      itemName,
      qty: Number(qty || 1),
      unitPrice: normalizePrice(unitPrice),
      meta
    });
    save();
  }

  function updateLine(id, patch) {
    const i = state.lines.findIndex(l => l.id === id);
    if (i >= 0) {
      const next = { ...state.lines[i], ...patch };
      if ("unitPrice" in patch) next.unitPrice = normalizePrice(next.unitPrice);
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
  // Totals / Summary
  // =========================
  function totals() {
    const subtotal = state.lines.reduce((s, l) => s + normalizePrice(l.unitPrice) * Number(l.qty || 0), 0);
    const pct = (window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feePercent || 0)) || 0;
    const flat = toCentsAuto((window.SITE_SETTINGS && Number(window.SITE_SETTINGS.feeFlat || 0)) || 0);
    const fee = subtotal > 0 ? Math.round(subtotal * (pct / 100)) + flat : 0;
    const total = subtotal + fee;
    return { subtotal, fee, total, pct, flat };
  }

  function summary() { return { ...get(), ...totals() }; }

  // =========================
  // Checkout payload helper
  // =========================
  // Builds the "lines" array formatted for /api/router?action=create_checkout_session
  function buildCheckoutLines() {
    return state.lines.map(l => ({
      itemId: l.itemId,
      itemType: l.itemType || "product",
      itemName: l.itemName,
      qty: Number(l.qty || 1),
      unitPrice: normalizePrice(l.unitPrice),   // cents or dollars; server will toCentsAuto again safely
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