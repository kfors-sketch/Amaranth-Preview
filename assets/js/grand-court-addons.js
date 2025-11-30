// /assets/js/grand-court-addons.js
(function () {
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

  function normalizeAddon(raw) {
    const a = Object.assign({}, raw || {});

    a.id = String(a.id || "").trim();
    a.name = String(a.name || "").trim() || a.id || "Add-On";
    a.type = String(a.type || "fixed").trim();

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
          id: String(v.id || v.label || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
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
      addons = j.addons.map(normalizeAddon).filter((a) => a.active && isWithinWindow(a, now));
    }

    // 2) Fallback to static list (items.js) if server empty/unavailable
    if (!addons.length && Array.isArray(window.GRAND_COURT_ADDONS)) {
      addons = window.GRAND_COURT_ADDONS.map(normalizeAddon).filter(
        (a) => a.active && isWithinWindow(a, now)
      );
    }

    return addons;
  }

  // ---- Attendee helpers (shared Cart structure) ----
  function getCartState() {
    if (!window.Cart || typeof Cart.get !== "function") return { attendees: [], lines: [] };
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
      return false;
    }

    const {
      qty,
      amount,
      attendee,
      variant,
    } = options || {};

    const quantity = Math.max(1, toNumber(qty || 1, 1));
    const price = toNumber(amount || addon.price || 0, 0);

    if (!price || price < 0) {
      alert("Please enter a valid amount.");
      return false;
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

    if (variant) {
      meta.variantId = variant.id || "";
      meta.variantLabel = variant.label || "";
    }

    // This shape is what order-page + backend expect
    Cart.addLine({
      itemType: "addon",
      itemId: addon.id,
      itemName: addon.name,
      qty: quantity,
      unitPrice: price,
      meta,
    });

    return true;
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

    if (addon.type === "amount") {
      // Open-dollar amount (e.g., Love Gift)
      const amtWrap = document.createElement("label");
      const amtLabel = document.createElement("span");
      const min = addon.minAmount || 0.01;
      amtLabel.textContent = `Amount (minimum ${money(min)})`;
      amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.min = String(min);
      amountInput.step = "0.01";
      amountInput.placeholder = money(min);
      amtWrap.appendChild(amtLabel);
      amtWrap.appendChild(amountInput);
      row.appendChild(amtWrap);
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

      row.appendChild(varWrap);
      row.appendChild(qtyWrap);
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
      // fixed
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
      const attendee =
        attKey ? findAttendeeByKey(attKey) : null;

      // For now we *strongly* prefer an attendee for all add-ons.
      if (!attendee) {
        alert("Please add an attendee above and select them for this add-on.");
        return;
      }

      let qty = 1;
      let amount = addon.price;
      let variant = null;

      if (addon.type === "amount") {
        const min = addon.minAmount || 0.01;
        amount = toNumber(amountInput && amountInput.value, 0);
        if (!amount || amount < min) {
          alert(`Please enter at least ${money(min)}.`);
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
        // fixed
        qty = 1;
        amount = addon.price || 0;
      }

      const ok = addAddonToCart(addon, {
        qty,
        amount,
        attendee,
        variant,
      });

      if (ok) {
        addBtn.textContent = "Added!";
        addBtn.disabled = true;
        setTimeout(() => {
          addBtn.textContent = "Add more";
          addBtn.disabled = false;
        }, 1200);

        // Let other scripts know cart changed
        try {
          window.dispatchEvent(new Event("cart:updated"));
        } catch (e) {}
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
