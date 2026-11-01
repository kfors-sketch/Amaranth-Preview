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

  function escAttr(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"
    }[ch]));
  }

  function uid(prefix) {
    return String(prefix || "id") + "_" + Math.random().toString(36).slice(2, 9);
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

    // Transportation payment mode support
    // free | fixed | donation | optionalDonation | request
    a.priceMode = String(a.priceMode || a.paymentMode || (a.type === "amount" ? "donation" : "fixed") || "fixed").trim();
    a.minDonation = toNumber(a.minDonation != null ? a.minDonation : a.minAmount, 0);
    a.paymentBasis = String(a.paymentBasis || "perRequest").trim();

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


  // ---- Transportation helpers ----
  function isTransportation(addon) {
    return String(addon?.type || "").toLowerCase() === "transportation" ||
           String(addon?.category || "").toLowerCase() === "transportation";
  }

  function normalizePhoneLike(s) {
    return String(s || "").trim();
  }

  function buildTransportationControls(addon, row) {
    const wrap = document.createElement("div");
    wrap.className = "transportation-box";
    wrap.style.cssText = "flex-basis:100%;display:flex;flex-direction:column;gap:12px;margin-top:8px;padding:12px;border:1px solid rgba(0,0,0,.10);border-radius:10px;background:rgba(255,255,255,.55);";

    const passengerCountId = uid("transportPassengerCount");
    const passengerCountLabel = document.createElement("label");
    passengerCountLabel.setAttribute("for", passengerCountId);
    passengerCountLabel.innerHTML = `<span>Number of people needing transportation</span>`;
    const passengerCount = document.createElement("input");
    passengerCount.id = passengerCountId;
    passengerCount.type = "number";
    passengerCount.min = "1";
    passengerCount.step = "1";
    passengerCount.value = "1";
    passengerCountLabel.appendChild(passengerCount);

    const passengersWrap = document.createElement("div");
    passengersWrap.className = "transport-passengers";
    passengersWrap.style.cssText = "display:flex;flex-direction:column;gap:10px;";

    function renderPassengers() {
      const n = Math.max(1, Math.min(20, Math.floor(toNumber(passengerCount.value, 1))));
      passengerCount.value = String(n);
      const old = [];
      passengersWrap.querySelectorAll(".transport-passenger").forEach((box) => {
        old.push({
          name: box.querySelector('[data-tp="name"]')?.value || "",
          phone: box.querySelector('[data-tp="phone"]')?.value || "",
          email: box.querySelector('[data-tp="email"]')?.value || "",
        });
      });
      passengersWrap.innerHTML = "";
      for (let i = 0; i < n; i++) {
        const data = old[i] || {};
        const box = document.createElement("div");
        box.className = "transport-passenger";
        box.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:end;";
        box.innerHTML = `
          <label><span>Passenger ${i + 1} name *</span><input data-tp="name" type="text" value="${escAttr(data.name)}" placeholder="Name" required></label>
          <label><span>Cell phone *</span><input data-tp="phone" type="tel" value="${escAttr(data.phone)}" placeholder="Phone" required></label>
          <label><span>Email</span><input data-tp="email" type="email" value="${escAttr(data.email)}" placeholder="Email optional"></label>
        `;
        passengersWrap.appendChild(box);
      }
    }

    passengerCount.addEventListener("input", renderPassengers);
    passengerCount.addEventListener("change", renderPassengers);

    const checks = document.createElement("div");
    checks.style.cssText = "display:flex;gap:18px;flex-wrap:wrap;align-items:center;";
    checks.innerHTML = `
      <label style="display:flex;flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-transport-pickup> Airport pickup needed</label>
      <label style="display:flex;flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-transport-dropoff> Airport drop-off needed</label>
    `;
    const pickupCheck = checks.querySelector("[data-transport-pickup]");
    const dropoffCheck = checks.querySelector("[data-transport-dropoff]");

    function makeFlightSection(kind) {
      const label = kind === "pickup" ? "Pickup / Arrival Information" : "Drop-off / Departure Information";
      const airportPlaceholder = kind === "pickup" ? "Arrival airport" : "Departure airport";
      const hourOptions = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
      const minuteOptions = Array.from({ length: 60 }, (_, i) => {
        const value = String(i).padStart(2, "0");
        return `<option value="${value}">${value}</option>`;
      }).join("");
      const section = document.createElement("div");
      section.className = `transport-${kind}-section`;
      section.style.cssText = "display:none;flex-direction:column;gap:8px;padding:10px;border:1px dashed rgba(0,0,0,.18);border-radius:8px;";
      section.innerHTML = `
        <strong>${label}</strong>
        <div class="grid-3">
          <label><span>Airport *</span><input data-${kind}="airport" type="text" placeholder="${airportPlaceholder}"></label>
          <label><span>Airline</span><input data-${kind}="airline" type="text" placeholder="Airline"></label>
          <label><span>Flight #</span><input data-${kind}="flight" type="text" placeholder="Flight number"></label>
        </div>
        <div style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(300px,2fr);gap:10px;align-items:end;">
          <label><span>Date *</span><input data-${kind}="date" type="date"></label>
          <div>
            <span style="display:block;margin-bottom:4px;">Time *</span>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:nowrap;">
              <select data-${kind}="hour" aria-label="Hour" style="min-width:80px;flex:1;">
                <option value="">Hour</option>${hourOptions}
              </select>
              <select data-${kind}="minute" aria-label="Minute" style="min-width:90px;flex:1;">
                <option value="">Minute</option>${minuteOptions}
              </select>
              <select data-${kind}="ampm" aria-label="AM or PM" style="min-width:100px;flex:1;">
                <option value="">AM/PM</option>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          </div>
        </div>
        <div>
          <label style="display:block;"><span>Notes</span><input data-${kind}="notes" type="text" placeholder="Special pickup/drop-off notes" style="width:100%;"></label>
        </div>
      `;
      return section;
    }

    const pickupSection = makeFlightSection("pickup");
    const dropoffSection = makeFlightSection("dropoff");

    function updateSections() {
      pickupSection.style.display = pickupCheck.checked ? "flex" : "none";
      dropoffSection.style.display = dropoffCheck.checked ? "flex" : "none";
    }
    pickupCheck.addEventListener("change", updateSections);
    dropoffCheck.addEventListener("change", updateSections);

    let donationInput = null;
    const paymentMode = String(addon.priceMode || "fixed");
    const paymentBox = document.createElement("div");
    paymentBox.className = "transport-payment";

    if (paymentMode === "free") {
      paymentBox.innerHTML = `<p><strong>No charge</strong></p>`;
    } else if (paymentMode === "request") {
      paymentBox.innerHTML = `<p><strong>No online payment collected.</strong> The transportation chairperson will follow up if needed.</p>`;
    } else if (paymentMode === "donation" || paymentMode === "optionalDonation") {
      const min = Math.max(0, Math.ceil(toNumber(addon.minDonation, 0)));
      const requiredText = paymentMode === "donation" ? "Donation amount *" : "Optional donation";
      paymentBox.innerHTML = `
        <label><span>${requiredText}${min ? ` (minimum ${money(min)})` : ""}</span><input data-transport-donation type="number" min="${min}" step="1" inputmode="numeric" placeholder="${min || 0}"></label>
      `;
      donationInput = paymentBox.querySelector("[data-transport-donation]");
    } else {
      const basis = addon.paymentBasis === "perRequest" ? "per request / group" : "per person";
      paymentBox.innerHTML = `<p><strong>${money(addon.price || 0)}</strong> ${basis}</p>`;
    }

    wrap.appendChild(passengerCountLabel);
    wrap.appendChild(passengersWrap);
    wrap.appendChild(checks);
    wrap.appendChild(pickupSection);
    wrap.appendChild(dropoffSection);
    wrap.appendChild(paymentBox);
    row.appendChild(wrap);

    renderPassengers();
    updateSections();

    return {
      passengerCount,
      passengersWrap,
      pickupCheck,
      dropoffCheck,
      pickupSection,
      dropoffSection,
      donationInput,
      collect() {
        const passengers = Array.from(passengersWrap.querySelectorAll(".transport-passenger")).map((box, idx) => ({
          number: idx + 1,
          name: String(box.querySelector('[data-tp="name"]')?.value || "").trim(),
          phone: normalizePhoneLike(box.querySelector('[data-tp="phone"]')?.value || ""),
          email: String(box.querySelector('[data-tp="email"]')?.value || "").trim(),
        }));

        for (const p of passengers) {
          if (!p.name || !p.phone) return { ok:false, error:"passenger_required", message:"Please enter a name and cell phone for every passenger." };
        }

        const pickupNeeded = !!pickupCheck.checked;
        const dropoffNeeded = !!dropoffCheck.checked;
        if (!pickupNeeded && !dropoffNeeded) {
          return { ok:false, error:"ride_choice_required", message:"Please check Airport pickup, Airport drop-off, or both." };
        }

        function collectSection(kind, section, needed) {
          if (!needed) return { needed:false };
          const date = String(section.querySelector(`[data-${kind}="date"]`)?.value || "").trim();
          const hour = String(section.querySelector(`[data-${kind}="hour"]`)?.value || "").trim();
          const minute = String(section.querySelector(`[data-${kind}="minute"]`)?.value || "").trim();
          const ampm = String(section.querySelector(`[data-${kind}="ampm"]`)?.value || "").trim();
          const obj = {
            needed:true,
            airport: String(section.querySelector(`[data-${kind}="airport"]`)?.value || "").trim(),
            airline: String(section.querySelector(`[data-${kind}="airline"]`)?.value || "").trim(),
            flight: String(section.querySelector(`[data-${kind}="flight"]`)?.value || "").trim(),
            date,
            time: hour && minute && ampm ? `${hour}:${minute} ${ampm}` : "",
            datetime: date && hour && minute && ampm ? `${date} ${hour}:${minute} ${ampm}` : "",
            notes: String(section.querySelector(`[data-${kind}="notes"]`)?.value || "").trim(),
          };
          if (!obj.airport || !date || !hour || !minute || !ampm) {
            return { error:true, message: kind === "pickup" ? "Please enter pickup airport, arrival date, and arrival time." : "Please enter drop-off airport, departure date, and departure time." };
          }
          return obj;
        }

        const pickup = collectSection("pickup", pickupSection, pickupNeeded);
        if (pickup.error) return { ok:false, error:"pickup_required", message:pickup.message };
        const dropoff = collectSection("dropoff", dropoffSection, dropoffNeeded);
        if (dropoff.error) return { ok:false, error:"dropoff_required", message:dropoff.message };

        let donationAmount = 0;
        if (donationInput) {
          donationAmount = Math.floor(toNumber(donationInput.value, 0));
          const min = Math.max(0, Math.ceil(toNumber(addon.minDonation, 0)));
          if (paymentMode === "donation" && donationAmount < Math.max(1, min)) {
            return { ok:false, error:"donation_required", message:`Please enter a donation amount of at least ${money(Math.max(1, min))}.` };
          }
          if (paymentMode === "optionalDonation" && donationAmount > 0 && donationAmount < min) {
            return { ok:false, error:"donation_minimum", message:`Optional donation must be at least ${money(min)} or left blank.` };
          }
        }

        return {
          ok:true,
          passengerCount: passengers.length,
          passengers,
          pickup,
          dropoff,
          paymentMode,
          paymentBasis: addon.paymentBasis || "perPerson",
          donationAmount,
        };
      }
    };
  }

  // ---- Cart: add an add-on line ----
  function addAddonToCart(addon, options) {
    if (!window.Cart || typeof Cart.addLine !== "function") {
      alert("Cart is not available yet. Please try again in a moment.");
      return { ok: false, error: "cart_unavailable" };
    }

    const { qty, amount, attendee, variant, notes, wear, transportation } = options || {};

    const transport = isTransportation(addon);
    // Transportation is intentionally purchaser-level/standalone.
    // It should not require or attach to an attendee record.
    const attendeeId = transport ? "(unassigned)" : (attendee && attendee.id ? String(attendee.id) : "");
    const onePerAttendee =
      addon && addon.type ? !["amount", "variantQty", "qty", "transportation"].includes(String(addon.type)) : true;

    const quantity = Math.max(1, toNumber(qty || 1, 1));
    const price = toNumber(amount || addon.price || 0, 0);

    if ((!transport && !price) || price < 0) {
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

    // Transportation structured data for reports / chairperson exports
    if (transportation && transport) {
      meta.category = "transportation";
      meta.transportation = transportation;
      meta.passengerCount = transportation.passengerCount || 0;
      meta.pickupNeeded = !!transportation?.pickup?.needed;
      meta.dropoffNeeded = !!transportation?.dropoff?.needed;
      meta.paymentMode = transportation.paymentMode || addon.priceMode || "fixed";
      meta.paymentBasis = transportation.paymentBasis || addon.paymentBasis || "perPerson";
      meta.itemNote = [
        meta.pickupNeeded ? "Pickup needed" : "",
        meta.dropoffNeeded ? "Drop-off needed" : "",
        `${meta.passengerCount || 0} passenger(s)`
      ].filter(Boolean).join("; ");
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

    alert(transport ? 'Transportation request added' : 'Add-on added');
    return { ok: true, onePerAttendee, attendeeId };
  }

  // ---- Render helpers ----
  function renderEmptyMessage(grid) {
    grid.innerHTML = `
      <section class="card">
        <h2>No add-ons available</h2>
        <p>
          There are currently no Supreme add-ons open for registration.
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
    let transportControls = null;
if (isTransportation(addon)) {
      transportControls = buildTransportationControls(addon, row);
    } else if (addon.type === "amount") {
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
      addon && addon.type ? !["amount", "variantQty", "qty", "transportation"].includes(String(addon.type)) : true;

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

    if (!isTransportation(addon)) {
      attendeeSelect.addEventListener("change", refreshAddBtnState);
    }
    setTimeout(refreshAddBtnState, 0);

    // assemble row
    // Transportation is standalone: passenger/contact fields inside the Transportation
    // form are the source of truth, so no attendee selector is needed.
    if (!isTransportation(addon)) {
      row.appendChild(attendeeWrap);
    }
    card.appendChild(title);
    if (addon.description) card.appendChild(desc);
    card.appendChild(row);
    card.appendChild(btnWrap);

    // Initial attendee options (normal add-ons only)
    if (!isTransportation(addon)) {
      buildAttendeeOptions(getAttendees(), attendeeSelect);
    }

    // Click handler
    addBtn.addEventListener("click", () => {
      const isTransport = isTransportation(addon);
      const attKey = isTransport ? "" : (attendeeSelect.value || "");
      const attendee = attKey ? findAttendeeByKey(attKey) : null;

      if (!isTransport && !attendee) {
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

      let transportation = null;
      if (isTransportation(addon)) {
        if (!transportControls || typeof transportControls.collect !== "function") {
          alert("Transportation form is not available. Please refresh and try again.");
          return;
        }
        const collected = transportControls.collect();
        if (!collected.ok) {
          alert(collected.message || "Please complete the transportation information.");
          return;
        }
        transportation = collected;
        const mode = String(addon.priceMode || collected.paymentMode || "fixed");
        if (mode === "free" || mode === "request") {
          qty = collected.passengerCount || 1;
          amount = 0;
        } else if (mode === "donation" || mode === "optionalDonation") {
          qty = 1;
          amount = collected.donationAmount || 0;
        } else {
          qty = addon.paymentBasis === "perRequest" ? 1 : (collected.passengerCount || 1);
          amount = addon.price || 0;
        }
      } else if (addon.type === "amount") {
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
        transportation,
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


