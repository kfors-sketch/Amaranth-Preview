// /assets/js/grand-court-addons.js
(function () {

// -----------------------------------------------------------------------------
// SAFETY: bind once (prevents double-add / double-alert if script is loaded twice)
// -----------------------------------------------------------------------------
if (typeof window !== "undefined") {
  window.__amaranth_addons_bound = window.__amaranth_addons_bound || false;
}

  const GRID_ID = "addonsGrid";

  // --- Simple money formatter (USD) ---
  function money(n) {
    const v = Math.round(Number(n || 0) * 100) / 100;
    return v.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      style: "currency",
      currency: "USD",
    });
  }

  function toNumber(n, def = 0) {
    const v = Number(n);
    return isFinite(v) ? v : def;
  }

  // NEW: sort helper (lower sortOrder first; tie-break by name)
  function sortBySortOrder(a, b) {
    const ao = Number(a?.sortOrder ?? 1000);
    const bo = Number(b?.sortOrder ?? 1000);
    if (ao !== bo) return ao - bo;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  }

  function normalizeAddon(raw) {
    const a = Object.assign({}, raw || {});

    a.id = String(a.id || "").trim();
    a.name = String(a.name || "").trim() || a.id || "Add-On";
    a.type = String(a.type || "fixed").trim();

    // NEW: sortOrder (admin + public)
    // default 1000 so legacy items naturally fall to the bottom
    a.sortOrder = Number(a.sortOrder ?? 1000);
    if (!isFinite(a.sortOrder)) a.sortOrder = 1000;

    // price in *dollars* for UI
    if (a.price != null) {
      a.price = toNumber(a.price, 0);
    } else {
      a.price = 0;
    }

    // optional min amount for "amount" type (e.g., love-gift)
    if (a.minAmount != null) {
      a.minAmount = toNumber(a.minAmount, 0.01);
    }

    // flags
    if (a.active === undefined || a.active === null) {
      a.active = true;
    } else {
      a.active = a.active !== false;
    }

    a.publishStart = a.publishStart || "";
    a.publishEnd = a.publishEnd || "";
    a.description = a.description || "";

    // variants: normalize to [{id,label,price}]
    if (Array.isArray(a.variants)) {
      a.variants = a.variants.map((v) => {
        if (typeof v === "string") {
          return {
            id: v.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
            label: v,
            price: a.price || 0,
          };
        }
        return {
          id: String(v.id || v.label || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-"),
          label: String(v.label || v.name || "").trim() || "Option",
          price: toNumber(v.price != null ? v.price : a.price || 0, 0),
        };
      });
    } else {
      a.variants = [];
    }

    return a;
  }

  function isWithinWindow(addon, nowMs) {
    const s = addon.publishStart ? Date.parse(addon.publishStart) : NaN;
    const e = addon.publishEnd ? Date.parse(addon.publishEnd) : NaN;
    if (!isFinite(nowMs)) nowMs = Date.now();

    if (!isNaN(s) && nowMs < s) return false;
    if (!isNaN(e) && nowMs > e) return false;
    return true;
  }

  async function fetchJson(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      console.warn("addons fetch failed", e);
      return null;
    }
  }

  async function loadAddons() {
    const now = Date.now();
    let addons = [];

    // 1) Try from backend (KV)
    const j = await fetchJson("/api/router?type=addons");
    if (Array.isArray(j?.addons) && j.addons.length) {
      addons = j.addons
        .map(normalizeAddon)
        .filter((a) => a.active && isWithinWindow(a, now))
        .slice()
        .sort(sortBySortOrder); // NEW
    }

    // 2) Fallback to static list if server empty/unavailable
    if (!addons.length && Array.isArray(window.GRAND_COURT_ADDONS)) {
      addons = window.GRAND_COURT_ADDONS
        .map(normalizeAddon)
        .filter((a) => a.active && isWithinWindow(a, now))
        .slice()
        .sort(sortBySortOrder); // NEW
    }

    return addons;
  }

  // ---- Attendee helpers (shared Cart structure) ----
  function getCartState() {
    if (!window.Cart || typeof Cart.get !== "function")
      return { attendees: [], lines: [] };
    try {
      return Cart.get() || { attendees: [], lines: [] };
    } catch (e) {
      console.error("Cart.get failed", e);
      return { attendees: [], lines: [] };
    }
  }

  function getAttendees() {
    const st = getCartState();
    return Array.isArray(st.attendees) ? st.attendees : [];
  }

  function buildAttendeeOptions(attendees, selectEl) {
    selectEl.innerHTML = "";

    const optNone = document.createElement("option");
    optNone.value = "";
    optNone.textContent = attendees.length
      ? "Select attendee…"
      : "Add an attendee above first";
    selectEl.appendChild(optNone);

    attendees.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.id || a.email || a.name || "";
      opt.textContent = a.name || a.email || "Attendee";
      opt.dataset.attId = a.id || "";
      selectEl.appendChild(opt);
    });

    selectEl.disabled = attendees.length === 0;
  }

  function findAttendeeByKey(key) {
    if (!key) return null;
    const attendees = getAttendees();
    return (
      attendees.find((a) => a.id === key) ||
      attendees.find((a) => a.email === key) ||
      attendees.find((a) => a.name === key) ||
      null
    );
  }

  // ---- Cart: add an add-on line ----
  function addAddonToCart(addon, options) {
    if (!window.Cart || typeof Cart.addLine !== "function") {
      alert("Cart is not available yet. Please try again in a moment.");
      return { ok: false, error: "cart_unavailable" };
    }

    const { qty, amount, attendee, variant, notes, wear } = options || {};

    const attendeeId = attendee && attendee.id ? String(attendee.id) : "";
    const onePerAttendee =
      addon && addon.type ? !["amount", "variantQty", "qty"].includes(String(addon.type)) : true;

    const quantity = Math.max(1, toNumber(qty || 1, 1));
    const price = toNumber(amount || addon.price || 0, 0);

    if (!price || price < 0) {
      alert("Please enter a valid amount.");
      return { ok: false, error: "invalid_amount" };
    }

    
    // ✅ Corsage wear style (required)
    if (addon && String(addon.id) === "corsage") {
      const w = String(wear || "").trim().toLowerCase();
      if (!w || (w !== "wrist" && w !== "pin")) {
        alert("Please choose Wrist or Pin-on for the corsage.");
        return { ok: false, error: "missing_wear" };
      }
    }
// ✅ Prevent accidental duplicates for single-per-attendee add-ons
    try {
      if (onePerAttendee && attendeeId && typeof Cart.get === "function") {
        const state = Cart.get() || {};
        const lines = Array.isArray(state.lines) ? state.lines : [];
        const already = lines.some(
          (ln) =>
            String(ln.itemType || "") === "addon" &&
            String(ln.itemId || "") === String(addon.id || "") &&
            String(ln.attendeeId || "") === attendeeId
        );
        if (already) {
          alert("This attendee is already assigned to this add-on.");
    return { ok: false, error: "already_assigned" };
        }
      }
    } catch (e) {
      // don't block adding if the precheck fails
    }

    const meta = {};

    if (attendee) {
      meta.attendeeId = attendee.id || "";
      meta.attendeeName = attendee.name || "";
      meta.attendeeEmail = attendee.email || "";
      meta.attendeePhone = attendee.phone || "";
      meta.attendeeTitle = attendee.title || "";
      meta.attendeeNotes = attendee.notes || "";

      meta.attendeeAddr1 = attendee.address1 || "";
      meta.attendeeAddr2 = attendee.address2 || "";
      meta.attendeeCity = attendee.city || "";
      meta.attendeeState = attendee.state || "";
      meta.attendeePostal = attendee.postal || "";
      meta.attendeeCountry = attendee.country || "";
    }

// ✅ Pre-Registration: carry Voting / Non-Voting into receipt "Notes:" (like banquet notes)
// Stripe/receipt do NOT automatically show attendee voting unless we store it on the line meta.
if (addon && (String(addon.id) === "pre-reg" || String(addon.id) === "pre_registration" || /pre\s*registration/i.test(String(addon.name || "")))) {
  // try multiple attendee fields (different pages may store it differently)
  const raw =
    attendee.votingStatus ??
    attendee.voting_status ??
    attendee.voting ??
    attendee.isVoting ??
    attendee.is_voting ??
    attendee.memberType ??
    attendee.membershipType ??
    "";

  let label = "";
  const v = String(raw || "").trim().toLowerCase();
  if (v === "voting" || v === "yes" || v === "true" || v === "1") label = "Voting";
  else if (v === "non-voting" || v === "nonvoting" || v === "no" || v === "false" || v === "0") label = "Non-Voting";

  // fallback: some UIs embed it in the title string
  if (!label) {
    const titleText = String(attendee.title || "").toLowerCase();
    if (titleText.includes("non-voting") || titleText.includes("nonvoting")) label = "Non-Voting";
    else if (titleText.includes("voting")) label = "Voting";
  }

  if (label) {
    // Make receipts show it exactly like banquet notes
    meta.itemNote = meta.itemNote || `Member: ${label}`;
    meta.attendeeNotes = meta.attendeeNotes || meta.itemNote;
    meta.notes = meta.notes || meta.itemNote;
    // Also helpful for downstream parsing
    meta.votingStatus = meta.votingStatus || label;
    meta.isVoting = meta.isVoting || (label === "Voting" ? "true" : "false");
  }
}

    if (variant) {
      meta.variantId = variant.id || "";
      meta.variantLabel = variant.label || "";
    }


// ✅ Corsage option normalization (so order page + receipts show which option)
if (addon && String(addon.id) === "corsage" && variant) {
  meta.corsageChoice = variant.label || "";
  meta.corsageIsCustom = /custom/i.test(String(variant.label || ""));
}

    

    // ✅ Corsage wear style
    if (addon && String(addon.id) === "corsage") {
      const w = String(wear || "").trim().toLowerCase();
      if (w) {
        meta.corsageWear = w;
        meta.corsage_wear = w;
      }
    }
if (notes) {
      meta.notes = notes; // carry custom/notes text to reports
    }


// Also store canonical note fields so receipts/order page always show them
if (notes) {
  // Love Gift message
  if (addon && (String(addon.id) === "love-gift" || String(addon.id) === "love_gift" || String(addon.id) === "love gift")) {
    meta.itemNote = notes;
  }
  // Corsage custom instructions
  if (addon && String(addon.id) === "corsage") {
    meta.itemNote = notes;     // primary
    meta.corsageNote = notes;  // secondary (explicit)
  }
}

    // WHOLE DOLLARS ONLY marker for amount-type add-ons (e.g., Love Gift)
    if (addon && String(addon.type) === "amount") {
      meta.wholeDollarsOnly = true;
      // amount in this file is expressed in dollars (integer)
      meta.dollars = price;
    }

    // ✅ IMPORTANT: attendeeId MUST also be top-level so Cart.mergeLine keeps lines separate per attendee
    Cart.addLine({
      attendeeId: attendeeId || "",
      itemType: "addon",
      itemId: addon.id,
      itemName: addon.name,
      qty: quantity,
      unitPrice: price,
      meta,
    });

    alert('Add-on added');
    return { ok: true, onePerAttendee, attendeeId };
  }

  // ---- Render helpers ----
  function renderEmptyMessage(grid) {
    grid.innerHTML = `
      <section class="card">
        <h2>No add-ons available</h2>
        <p>
          There are currently no Grand Court add-ons open for registration.
          Please check back later or contact the committee with any questions.
        </p>
      </section>
    `;
  }

  function buildCard(addon) {
    const card = document.createElement("section");
    card.className = "card addon";

    const title = document.createElement("h2");
    title.textContent = addon.name;

    const desc = document.createElement("p");
    desc.textContent = addon.description || "";

    const row = document.createElement("div");
    row.className = "row";

    // --- Attendee select (shared with Banquets) ---
    const attendeeWrap = document.createElement("label");
    const attendeeLabel = document.createElement("span");
    attendeeLabel.textContent = "Attendee for this add-on";
    const attendeeSelect = document.createElement("select");
    attendeeSelect.setAttribute("data-attendee-select", addon.id);
    attendeeWrap.appendChild(attendeeLabel);
    attendeeWrap.appendChild(attendeeSelect);

    // --- Controls differ by type ---
    let qtyInput = null;
    let amountInput = null;
    let variantSelect = null;
    let notesInput = null;
    let wearSelect = null;
if (addon.type === "amount") {
      const amtWrap = document.createElement("label");
      const amtLabel = document.createElement("span");

      // WHOLE DOLLARS ONLY (no cents)
      const min = Math.max(1, Math.ceil(addon.minAmount || 1));
      amtLabel.textContent = `Amount (whole dollars only, minimum ${money(min)})`;

      amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.min = String(min);
      amountInput.step = "1";
      amountInput.inputMode = "numeric";
      amountInput.placeholder = String(min);

      // hard-stop: prevent decimals even on paste/scroll
      amountInput.addEventListener("input", () => {
        const v = Math.floor(Number(amountInput.value || min));
        amountInput.value = String(Math.max(min, v));
      });

amtWrap.appendChild(amtLabel);
      amtWrap.appendChild(amountInput);
      row.appendChild(amtWrap);

      const notesWrap = document.createElement("label");
      const notesLabel = document.createElement("span");
      notesLabel.textContent = "Notes (optional)";
      notesInput = document.createElement("input");
      notesInput.type = "text";
      notesInput.placeholder = "Message or special instructions";
      notesWrap.appendChild(notesLabel);
      notesWrap.appendChild(notesInput);
      row.appendChild(notesWrap);
    } else if (addon.type === "variantQty" && addon.variants.length) {
      const varWrap = document.createElement("label");
      const varLabel = document.createElement("span");
      varLabel.textContent = "Option";
      variantSelect = document.createElement("select");

      addon.variants.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.id || v.label;
        opt.textContent = `${v.label} — ${money(v.price)}`;
        opt.dataset.price = String(v.price || 0);
        variantSelect.appendChild(opt);
      });

      varWrap.appendChild(varLabel);
      varWrap.appendChild(variantSelect);

      const qtyWrap = document.createElement("label");
      const qtyLabel = document.createElement("span");
      qtyLabel.textContent = "Quantity";
      qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.min = "1";
      qtyInput.step = "1";
      qtyInput.value = "1";
      qtyWrap.appendChild(qtyLabel);
      qtyWrap.appendChild(qtyInput);

      const notesWrap = document.createElement("label");
      const notesLabel = document.createElement("span");
      notesLabel.textContent = "Notes (optional)";
      notesInput = document.createElement("input");
      notesInput.type = "text";
      notesInput.placeholder =
        "Custom flowers, colors, ribbon, or other details";
      notesWrap.appendChild(notesLabel);
      notesWrap.appendChild(notesInput);

      row.appendChild(varWrap);
      row.appendChild(qtyWrap);

      // ✅ Corsage: Wear Style (Wrist / Pin-on)
      if (addon && String(addon.id) === "corsage") {
        const wearWrap = document.createElement("label");
        const wearLabel = document.createElement("span");
        wearLabel.textContent = "Wear Style *";
        wearSelect = document.createElement("select");
        wearSelect.innerHTML = `
          <option value="">Select wear style…</option>
          <option value="wrist">Wrist</option>
          <option value="pin">Pin-on</option>
        `;
        wearWrap.appendChild(wearLabel);
        wearWrap.appendChild(wearSelect);
        row.appendChild(wearWrap);
      }

      row.appendChild(notesWrap);
} else if (addon.type === "qty") {
      const qtyWrap = document.createElement("label");
      const qtyLabel = document.createElement("span");
      qtyLabel.textContent = `Quantity (${money(addon.price)} each)`;
      qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.min = "1";
      qtyInput.step = "1";
      qtyInput.value = "1";
      qtyWrap.appendChild(qtyLabel);
      qtyWrap.appendChild(qtyInput);
      row.appendChild(qtyWrap);
    } else {
      const priceP = document.createElement("p");
      priceP.innerHTML = `<strong>${money(addon.price)}</strong> each (limit 1 per attendee)`;
      card.appendChild(priceP);
    }

    // --- Button ---
    const btnWrap = document.createElement("div");
    btnWrap.className = "inline";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "Add to cart";
    btnWrap.appendChild(addBtn);

    // Keep button state in sync: single-per-attendee add-ons should not be added twice
    const isOnePerAttendee =
      addon && addon.type ? !["amount", "variantQty", "qty"].includes(String(addon.type)) : true;

    const refreshAddBtnState = () => {
      if (!isOnePerAttendee) {
        // quantity-style items can always be added again
        if (!addBtn.disabled) addBtn.textContent = "Add to cart";
        return;
      }

      const attKey = attendeeSelect.value || "";
      const attendee = attKey ? findAttendeeByKey(attKey) : null;
      const attendeeId = attendee && attendee.id ? String(attendee.id) : "";

      let already = false;
      try {
        if (attendeeId && window.Cart && typeof Cart.get === "function") {
          const state = Cart.get() || {};
          const lines = Array.isArray(state.lines) ? state.lines : [];
          already = lines.some(
            (ln) =>
              String(ln.itemType || "") === "addon" &&
              String(ln.itemId || "") === String(addon.id || "") &&
              String(ln.attendeeId || "") === attendeeId
          );
        }
      } catch {}

      if (already) {
        alert("This attendee is already assigned to this add-on.");
    addBtn.textContent = "Added";
        addBtn.disabled = true;
      } else {
        addBtn.textContent = "Add to cart";
        addBtn.disabled = false;
      }
    };

    attendeeSelect.addEventListener("change", refreshAddBtnState);
    setTimeout(refreshAddBtnState, 0);

    // assemble row
    row.appendChild(attendeeWrap);
    card.appendChild(title);
    if (addon.description) card.appendChild(desc);
    card.appendChild(row);
    card.appendChild(btnWrap);

    // Initial attendee options
    buildAttendeeOptions(getAttendees(), attendeeSelect);

    // Click handler
    addBtn.addEventListener("click", () => {
      const attKey = attendeeSelect.value || "";
      const attendee = attKey ? findAttendeeByKey(attKey) : null;

      if (!attendee) {
        alert("Please add an attendee above and select them for this add-on.");
        return;
      }

      let qty = 1;
      let amount = addon.price;
      let variant = null;
      const notes =
        notesInput && typeof notesInput.value === "string"
          ? notesInput.value.trim()
          : "";

      if (addon.type === "amount") {
        const min = Math.max(1, Math.ceil(addon.minAmount || 1));

        // WHOLE DOLLARS ONLY (no cents)
        amount = Math.floor(toNumber(amountInput && amountInput.value, 0));

        if (!Number.isInteger(amount) || amount < min) {
          alert(`Please enter a whole dollar amount of at least ${money(min)}.`);
          return;
        }
      } else if (addon.type === "variantQty") {
        const val = variantSelect ? variantSelect.value : "";
        const selected =
          addon.variants.find((v) => v.id === val || v.label === val) ||
          addon.variants[0] ||
          null;
        if (!selected) {
          alert("Please choose an option.");
          return;
        }
        variant = selected;
        qty = toNumber(qtyInput && qtyInput.value, 1);
        if (qty <= 0) {
          alert("Quantity must be at least 1.");
          return;
        }
        amount = selected.price || 0;
      } else if (addon.type === "qty") {
        qty = toNumber(qtyInput && qtyInput.value, 1);
        if (qty <= 0) {
          alert("Quantity must be at least 1.");
          return;
        }
        amount = addon.price || 0;
      } else {
        qty = 1;
        amount = addon.price || 0;
      }

      const ok = addAddonToCart(addon, {
        qty,
        amount,
        attendee,
        variant,
        notes,
              wear: wearSelect ? (wearSelect.value || "") : "",
      });

      if (ok && ok.ok) {
        const onePer = !!ok.onePerAttendee;

        // Success toast/popup (same vibe as banquets)
        try {

        } catch {}

        if (onePer) {
          // Single-per-attendee: lock the button for this attendee/item combo
          addBtn.textContent = "Added";
          addBtn.disabled = true;
        } else {
          // Quantity-style add-ons: allow adding more
          addBtn.textContent = "Added!";
          addBtn.disabled = true;
          setTimeout(() => {
            addBtn.disabled = false;
            addBtn.textContent = "Add More";
          }, 700);
        }
      } else {
        // Friendly duplicate message (like banquets)
        if (ok && ok.error === "already_assigned") {
          try {
            alert("This attendee is already assigned to this add-on.");;
          } catch {}
        }
      }
    });

    return card;
  }

  function rerenderAttendeeSelects() {
    const attendees = getAttendees();
    document
      .querySelectorAll("select[data-attendee-select]")
      .forEach((sel) => buildAttendeeOptions(attendees, sel));
  }

  async function init() {
  if (window.__amaranth_addons_bound) return;
  window.__amaranth_addons_bound = true;
    const grid = document.getElementById(GRID_ID);
    if (!grid) return;

    // Ensure Cart is ready
    if (window.Cart && typeof Cart.load === "function") {
      try {
        Cart.load();
      } catch (e) {
        console.warn("Cart.load failed", e);
      }
    }

    const addons = await loadAddons();
    if (!addons.length) {
      renderEmptyMessage(grid);
      return;
    }

    grid.innerHTML = "";
    addons.forEach((addon) => {
      grid.appendChild(buildCard(addon));
    });

    // Keep attendee dropdowns in sync when cart changes
    window.addEventListener("cart:updated", rerenderAttendeeSelects);
    window.addEventListener("focus", rerenderAttendeeSelects);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) rerenderAttendeeSelects();
    });
    window.addEventListener("storage", (ev) => {
      if (!ev.key || (window.Cart && ev.key === Cart.LS_KEY)) {
        rerenderAttendeeSelects();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
