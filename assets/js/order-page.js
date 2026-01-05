// /assets/js/order-page.js
(function () {
  // Dollars-safe UI formatter
  function money(n) {
    const v = Math.round(Number(n) * 100) / 100;
    return v.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      style: "currency",
      currency: "USD",
    });
  }

  // Treat 0<n<1 as cents
  function normalizePrice(p) {
    const n = Number(p);
    if (!isFinite(n)) return 0;
    return n > 0 && n < 1 ? Math.round(n * 100) : n;
  }

  // Simple email check
  function looksLikeEmail(s) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || "").trim());
  }

  // Supplies items that require court info (name/number/date/location)
  const COURT_INFO_ITEM_IDS = new Set(["hand-model-1218-seal-includes-postage", "desk-model-1218-seal-includes-postage"]);

  function cartNeedsCourtInfo(st) {
    const lines = (st && st.lines) ? st.lines : [];
    return lines.some(l => COURT_INFO_ITEM_IDS.has(String(l.itemId||l.id||"").trim().toLowerCase()));
  }

  function readCourtInfo() {
    return {
      name: String(document.getElementById("c_name")?.value || "").trim(),
      number: String(document.getElementById("c_number")?.value || "").trim(),
      organized: String(document.getElementById("c_organized")?.value || "").trim(),
      location: String(document.getElementById("c_location")?.value || "").trim(),
    };
  }

  function updateCourtInfoUI() {
    const card = document.getElementById("courtInfoCard");
    const hint = document.getElementById("courtInfoHint");
    if (!card || !window.Cart || typeof Cart.get !== "function") return;
    const needs = cartNeedsCourtInfo(Cart.get());
    card.style.display = needs ? "" : "none";
    if (hint) {
      hint.textContent = needs
        ? "Required for seals: Court name, Court number, Date organized, Location."
        : "";
    }
  }

  // ===========================================================================
  // API ERROR HELPERS (avoid "[object Object]" and show real router reason)
  // ===========================================================================
  function safeStringify(v) {
    try {
      if (typeof v === "string") return v;
      if (v == null) return "";
      return JSON.stringify(v, null, 2);
    } catch {
      try {
        return String(v);
      } catch {
        return "Unknown error";
      }
    }
  }

  function explainApiError(payload) {
    if (!payload) return "Unknown error";

    // Common router shapes:
    // { error: "router-failed", message: "..." }
    // { error: "stripe-not-configured" }
    // { error: "...", detail: "..." }
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

    const parts = [];
    if (msg) parts.push(String(msg));
    if (requestId) parts.push(`requestId: ${requestId}`);

    if (!parts.length) parts.push(safeStringify(payload));
    return parts.join("\n");
  }

  async function readJsonSafe(response) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // if server returned HTML or plain text error
      return { raw: text };
    }
  }
  // ===========================================================================

  // === Duplicate detection helpers (shared with other pages) ===
  function _norm(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }
  function _addressKey(a) {
    return [
      _norm(a?.address1),
      _norm(a?.address2),
      _norm(a?.city),
      _norm(a?.state),
      _norm(a?.postal),
      _norm(a?.country || "US"),
    ].join("|");
  }
  function _sameNameAndAddress(a, b) {
    return _norm(a?.name) === _norm(b?.name) && _addressKey(a) === _addressKey(b);
  }


// === Item detail helpers (corsage / love gift notes & choice) ===
function resolveItemNote(meta){
  const m = meta || {};
  let s = String(
    m.itemNote ||
    m.corsageNote ||
    m.note ||
    m.notes ||
    m.message ||
    ""
  ).trim();

  // If corsage wear style was embedded into itemNote for receipt compatibility,
  // strip it for on-screen "Note:" display (wear is shown separately).
  const hasCorsageWear = !!String(m.corsageWear || m.corsage_wear || "").trim();
  if (hasCorsageWear && /^wear:\s*/i.test(s)) {
    // "Wear: Wrist — note..." OR "Wear: Pin-on"
    const parts = s.split("—");
    if (parts.length >= 2) {
      s = parts.slice(1).join("—").trim();
    } else {
      s = "";
    }
  }

  return s;
}

function resolveCorsageChoice(meta){
  const m = meta || {};
  return String(
    m.corsageChoice ||
    m.corsageType ||
    m.choice ||
    m.selection ||
    m.option ||
    m.variant ||
    m.color ||
    m.style ||
    m.kind ||
    ""
  ).trim();
}

function resolveCorsageWear(meta){
  const m = meta || {};
  const w = String(
    m.corsageWear ||
    m.corsage_wear ||
    m.wear ||
    m.wearStyle ||
    ""
  ).trim().toLowerCase();
  if (w === "wrist") return "Wrist";
  if (w === "pin" || w === "pin-on" || w === "pinon") return "Pin-on";
  return "";
}

function isCorsageCustom(meta){
  const c = resolveCorsageChoice(meta).toLowerCase();
  return !!(meta && meta.corsageIsCustom) || c.includes("custom") || c === "c" || c === "other" || c === "special";
}
// ================================================================

  // ===== shared attendee storage key (same as other pages) =====
  const ATTENDEE_STORAGE_KEY = "amaranth_attendees_v1";

  function saveAttendeesToStorage(list) {
    try {
      const arr = Array.isArray(list) ? list : [];
      localStorage.setItem(ATTENDEE_STORAGE_KEY, JSON.stringify(arr));
    } catch (e) {
      console.error("Failed to save attendees to shared storage", e);
    }
  }

  function syncAttendeesToStorageFromCart() {
    try {
      if (!window.Cart || typeof Cart.get !== "function") return;
      const st = Cart.get() || {};
      const attendees = Array.isArray(st.attendees) ? st.attendees : [];
      saveAttendeesToStorage(attendees);
    } catch (e) {
      console.error("Failed to sync attendees from Cart to storage", e);
    }
  }

  // Purchaser name helper
  function getPurchaserName() {
    const name = (document.getElementById("p_name")?.value || "").trim();
    return name || "Purchaser";
  }

  // --- International fee helper (3% of subtotal for non-US) ---
  function computeInternationalFeeDollars(subtotalDollars, country) {
    const c = String(country || "").trim().toUpperCase();
    if (!c || c === "US" || c === "USA" || c === "UNITED STATES") return 0;

    // Do the math in cents so it matches backend rounding
    const subtotalCents = Math.round(Number(subtotalDollars || 0) * 100);
    if (subtotalCents <= 0) return 0;

    const feeCents = Math.round(subtotalCents * 0.03); // 3%
    return feeCents / 100;
  }

  // ------- RENDER LOGIC -------
  function render() {
    const st = Cart.get();

    // mirror attendees out on every render
    syncAttendeesToStorageFromCart();

    const list = document.getElementById("order-list");
    const summaryBox = document.getElementById("order-summary");
    const orderTotal = document.getElementById("order-total");

    // group lines by attendeeId (with purchaser bucket)
    const byA = {};
    (st.lines || []).forEach((l) => {
      (byA[l.attendeeId] ||= []).push(l);
    });

    // ---- helper to build one block with aligned columns + per-person subtotal ----
    function buildBlock(aid, lines) {
      // Resolve display name
      let displayName = "";
      let displayMeta = ""; // shows “Mailing address: attached/missing” + phone/email
      let a = null;

      if (aid === "(unassigned)") {
        displayName = getPurchaserName(); // no "(unassigned)" text
      } else {
        a = (st.attendees || []).find((x) => x.id === aid);
        displayName = a?.name || "Attendee";

        // Build small meta line (no raw address; just status)
        const hasAddr = !!(
          a?.address1 &&
          a?.city &&
          a?.state &&
          a?.postal &&
          a?.country
        );
        const addrStatus = hasAddr
          ? "Mailing address: attached"
          : "Mailing address: missing";
        const phone = a?.phone ? ` • ${a.phone}` : "";
        const email = a?.email ? ` • ${a.email}` : "";
        displayMeta = `<div class="att-meta tiny">${addrStatus}${phone}${email}</div>`;
      }

      // Inline edit form (for real attendees only)
      const showEdit = aid !== "(unassigned)";
      const editPanelId = `edit-${aid}`;

      let personSubtotal = 0;
      const rows = lines
        .map((l) => {
          const isBanquet = l.itemType === "banquet";
          const attObj = (st.attendees || []).find(
            (x) => x.id === (l.attendeeId || "")
          );
          const lnMeta =
            l.meta && l.meta.attendeeNotes ? String(l.meta.attendeeNotes) : "";
          const lnAtt = attObj && attObj.notes ? String(attObj.notes) : "";
          const banquetNotes = isBanquet ? lnMeta || lnAtt : "";

                    const itemNote = !isBanquet ? resolveItemNote(l.meta) : "";

          const isPreReg = /pre\s*reg/i.test(String(l.itemName||"")) || /pre[\s_-]*reg/i.test(String(l.itemId||""));
          const memberLabelForLine = (attObj?.memberType === "voting") ? "Voting" : ((attObj?.memberType === "non_voting") ? "Non-Voting" : "");
          const memberLine = (isPreReg && memberLabelForLine)
            ? `<div class="tiny" style="opacity:.85;">Member: ${memberLabelForLine}</div>`
            : "";

          const detail = memberLine + (banquetNotes
            ? `<div class="tiny" style="opacity:.85;">Notes: ${banquetNotes.replace(
                /</g,
                "&lt;"
              )}</div>`
            : itemNote
            ? `<div class="tiny" style="opacity:.85;">Note: ${itemNote.replace(
                /</g,
                "&lt;"
              )}</div>`
            : "");

          const corsageChoice = (String(l.itemId||"").toLowerCase() === "corsage") ? resolveCorsageChoice(l.meta) : "";
          const corsageLabel = (String(l.itemId||"").toLowerCase() === "corsage")
            ? (isCorsageCustom(l.meta) ? "Custom" : (corsageChoice ? corsageChoice : ""))
            : "";
          const corsageWear = (String(l.itemId||"").toLowerCase() === "corsage") ? resolveCorsageWear(l.meta) : "";
          const corsageSuffix = (String(l.itemId||"").toLowerCase() === "corsage")
            ? (corsageLabel || corsageWear ? ` (${[corsageLabel, corsageWear].filter(Boolean).map(s=>String(s).replace(/</g,"&lt;")).join(" • ")})` : "")
            : "";
          const price = normalizePrice(l.unitPrice);
          const qty = Number(l.qty || 0);
          const lineTotal = price * qty;
          personSubtotal += lineTotal;

          return `
            <tr>
              <td>${(l.itemName || "") + (corsageSuffix || "")}${detail}</td>
              <td class="ta-center">${qty}</td>
              <td class="ta-right">${money(price)}</td>
              <td class="ta-right">${money(lineTotal)}</td>
              <td><button data-remove="${l.id}">Remove</button></td>
            </tr>`;
        })
        .join("");

      return `
          <div class="att-block" data-aid="${aid}">
            <div class="att-head">
              <span>${displayName}</span>
              ${
                showEdit
                  ? `
                <button class="btn edit" data-edit="${aid}">Edit</button>
                <button class="remove-att" data-del="${aid}">Remove</button>
              `
                  : ""
              }
            </div>
            ${displayMeta || ""}

            
            ${a?.courtName || a?.courtNumber ? `<div class="tiny">Court: ${(a?.courtName||"")}${a?.courtNumber ? " #" + a.courtNumber : ""}</div>` : ""}
            ${a?.memberType ? `<div class="tiny">Member: ${a.memberType === "voting" ? "Voting" : "Non-Voting"}</div>` : ""}
${
              showEdit
                ? `
            <div class="edit-panel" id="${editPanelId}">
              <div class="row">
                <label>Name*<input type="text" class="ed-name" placeholder="Name *" required></label>
                <label>Email*<input type="email" class="ed-email" placeholder="Email *" required></label>
                <label>Phone*<input type="tel" class="ed-phone" placeholder="Phone *" required></label>
                <label>Title*<input type="text" class="ed-title" placeholder="Title *" required></label>

                
                <!-- NEW: Court fields -->
                <label>Court Name<input type="text" class="ed-court-name" placeholder="Court Name *" required></label>
                <label>Court #<input type="text" class="ed-court-number" placeholder="Court # *" required></label>

                <!-- NEW: Membership -->
                <div class="ed-member" style="display:flex;flex-direction:column;gap:6px;flex:1 1 100%;">
                  <span class="label" style="font-weight:600;font-size:12px;opacity:.9;">Membership *</span>
                  <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
                    <label style="display:flex;gap:6px;align-items:center;">
                      <input type="radio" name="ed-memberType" value="voting"> Voting
                    </label>
                    <label style="display:flex;gap:6px;align-items:center;">
                      <input type="radio" name="ed-memberType" value="non_voting"> Non-Voting
                    </label>
                  </div>
                </div>
<!-- Mailing address (required to be considered 'attached') -->
                <label>Address line 1*<input type="text" class="ed-addr1" placeholder="Address line 1 *" required></label>
                <label>Address line 2<input type="text" class="ed-addr2" placeholder="Address line 2"></label>
                <label>City*<input type="text" class="ed-city" placeholder="City *" required></label>
                <label>State/Province*<input type="text" class="ed-state" placeholder="State/Province *" required></label>
                <label>Postal code*<input type="text" class="ed-postal" placeholder="Postal code *" required></label>
                <label>Country*<input type="text" class="ed-country" placeholder="Country *" value="US" required></label>

                <label style="flex:1 1 100%">Notes<textarea class="ed-notes" rows="2" placeholder="Dietary needs, allergies, seating, etc."></textarea></label>
              </div>
              <div style="margin-top:.5rem; display:flex; gap:.5rem;">
                <button class="btn btn-primary save-ed" data-save="${aid}">Save</button>
                <button class="btn cancel-ed" data-cancel="${aid}">Cancel</button>
              </div>
            </div>`
                : ""
            }

            <table class="order-table">
              <colgroup>
                <col class="col-item">
                <col class="col-qty">
                <col class="col-price">
                <col class="col-total">
                <col class="col-action">
              </colgroup>
              <thead>
                <tr>
                  <th>Item</th>
                  <th class="ta-center">Qty</th>
                  <th class="ta-right">Price</th>
                  <th class="ta-right">Line Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="3" class="ta-right">Subtotal</td>
                  <td class="ta-right">${money(personSubtotal)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>`;
    }

    // ---- Build in desired order: Purchaser first, then Attendees in ADDED ORDER ----
    const blocks = [];

    // 1) Purchaser at the TOP if any lines exist
    if (byA["(unassigned)"] && byA["(unassigned)"].length) {
      blocks.push(buildBlock("(unassigned)", byA["(unassigned)"]));
    }

    // 2) Attendees in the order they were added (only if they have lines)
    const attendeesWithLines = (st.attendees || []).filter(
      (a) => byA[a.id] && byA[a.id].length
    );
    attendeesWithLines.forEach((a) => blocks.push(buildBlock(a.id, byA[a.id])));

    // 3) Edge case: stray attendeeIds not in st.attendees
    Object.entries(byA).forEach(([aid, lines]) => {
      if (aid === "(unassigned)") return;
      if (!(st.attendees || []).some((a) => a.id === aid)) {
        blocks.push(buildBlock(aid, lines));
      }
    });

    list.innerHTML = blocks.join("") || "<p>No items yet.</p>";

    // wire remove line
    list.querySelectorAll("button[data-remove]").forEach((b) => {
      b.onclick = () => {
        Cart.removeLine(b.dataset.remove);
      };
    });

    // wire attendee REMOVE (new)
    list.querySelectorAll("button[data-del]").forEach((btn) => {
      btn.onclick = () => {
        const aid = btn.dataset.del;
        if (!aid) return;
        if (
          !confirm(
            "Remove this attendee and all of their banquet/add-on assignments from the order?"
          )
        )
          return;
        Cart.removeAttendee(aid);
        // ping other tabs
        try {
          localStorage.setItem("amaranth_cart_ping", String(Date.now()));
        } catch (e) {}
        // re-render + resync attendees mirror
        window._orderRender?.();
        syncAttendeesToStorageFromCart();
      };
    });

    // wire edit show/hide + populate
    list.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const aid = btn.dataset.edit;
        const panel = document.getElementById(`edit-${aid}`);
        if (!panel) return;
        const st2 = Cart.get();
        const a = st2.attendees.find((x) => x.id === aid);
        panel.style.display = "block";
        panel.querySelector(".ed-name").value = a?.name || "";
        panel.querySelector(".ed-email").value = a?.email || "";
        panel.querySelector(".ed-phone").value = a?.phone || "";
        // live US formatting while typing (respects +international)
        const edPhone = panel.querySelector(".ed-phone");
        if (edPhone) {
          edPhone.addEventListener("input", () => formatPhoneLive(edPhone));
          edPhone.addEventListener("blur", () => formatPhoneLive(edPhone));
        }

        panel.querySelector(".ed-title").value = a?.title || "";
        
        panel.querySelector(".ed-court-name").value = a?.courtName || "";
        panel.querySelector(".ed-court-number").value = a?.courtNumber || "";
        const mt = a?.memberType || "";
        panel.querySelectorAll('input[name="ed-memberType"]').forEach(r => r.checked = (r.value === mt));
panel.querySelector(".ed-addr1").value = a?.address1 || "";
        panel.querySelector(".ed-addr2").value = a?.address2 || "";
        panel.querySelector(".ed-city").value = a?.city || "";
        panel.querySelector(".ed-state").value = a?.state || "";
        panel.querySelector(".ed-postal").value = a?.postal || "";
        panel.querySelector(".ed-country").value = a?.country || "US";
        if (panel.querySelector(".ed-notes"))
          panel.querySelector(".ed-notes").value = a?.notes || "";
      };
    });

    list.querySelectorAll(".cancel-ed").forEach((btn) => {
      btn.onclick = () => {
        const aid = btn.dataset.cancel;
        const panel = document.getElementById(`edit-${aid}`);
        if (panel) panel.style.display = "none";
        try {
          const st3 = Cart.get();
          const notes =
            panel?.querySelector?.(".ed-notes")?.value?.trim?.() || "";
          (st3.lines || []).forEach((l) => {
            if (l.attendeeId === aid && l.itemType === "banquet") {
              l.meta = l.meta || {};
              l.meta.attendeeNotes = notes;
              Cart.updateLine(l.id, { meta: l.meta });
            }
          });
        } catch (e) {}
        // re-render after cancel to refresh badges/notes
        window._orderRender?.();
      };
    });

    list.querySelectorAll(".save-ed").forEach((btn) => {
      btn.onclick = () => {
        const aid = btn.dataset.save;
        const panel = document.getElementById(`edit-${aid}`);
        if (!panel) return;

        // Read fields
        const name = panel.querySelector(".ed-name").value.trim();
        const email = panel.querySelector(".ed-email").value.trim();
        const phone = panel.querySelector(".ed-phone").value.trim();
        const title = panel.querySelector(".ed-title").value.trim();
        
        const courtName = panel.querySelector(".ed-court-name").value.trim();
        const courtNumber = panel.querySelector(".ed-court-number").value.trim();
        
        if (!courtName || !courtNumber) {
          alert('Court Name and Court # are required.');
          return;
        }
const memberTypeEl = panel.querySelector('input[name="ed-memberType"]:checked');
        const memberType = memberTypeEl ? memberTypeEl.value : "";
const addr1 = panel.querySelector(".ed-addr1").value.trim();
        const addr2 = panel.querySelector(".ed-addr2").value.trim();
        const city = panel.querySelector(".ed-city").value.trim();
        const state = panel.querySelector(".ed-state").value.trim();
        const postal = panel.querySelector(".ed-postal").value.trim();
        const country =
          panel.querySelector(".ed-country").value.trim() || "US";
        const notes = panel.querySelector(".ed-notes")
          ? panel.querySelector(".ed-notes").value.trim()
          : "";

        // Validate requireds (Title now required)
        const missing = [];
        if (!name) missing.push("Name");
        if (!email || !looksLikeEmail(email)) missing.push("Valid Email");
        if (!phone) missing.push("Phone");
        if (!title) missing.push("Title");
                if (!memberType) missing.push("Membership (Voting / Non-Voting)");
if (!addr1) missing.push("Address line 1");
        if (!city) missing.push("City");
        if (!state) missing.push("State/Province");
        if (!postal) missing.push("Postal code");
        if (!country) missing.push("Country");

        if (missing.length) {
          alert(
            "Please complete the following fields:\n• " +
              missing.join("\n• ")
          );
          return;
        }

        // ===== Duplicate prevention on edit (same Name + full address) =====
        try {
          const stDup = Cart.get() || { attendees: [] };
          const incoming = {
            name,
            address1: addr1,
            address2: addr2,
            city,
            state,
            postal,
            country,
          };
          const collision = (stDup.attendees || []).some(
            (a) => a.id !== aid && _sameNameAndAddress(a, incoming)
          );
          if (collision) {
            alert(
              "Another attendee with the same name and mailing address already exists."
            );
            return;
          }
        } catch (e) {}
        // =======================================================================

        // Save attendee (Cart must persist these fields)
        Cart.updateAttendee(aid, { name, email, phone, title, courtName, courtNumber, memberType, address1: addr1, address2: addr2, city, state, postal, country, notes });

        // Keep shared attendees mirror in sync
        syncAttendeesToStorageFromCart();

        // Optionally propagate notes to banquet lines for this attendee
        try {
          const st4 = Cart.get();
          (st4.lines || []).forEach((l) => {
            if (l.attendeeId === aid && l.itemType === "banquet") {
              l.meta = l.meta || {};
              l.meta.attendeeNotes = notes;
              Cart.updateLine(l.id, { meta: l.meta });
            }
          });
        } catch (e) {}

        panel.style.display = "none";
        window._orderRender?.();
      };
    });

    // totals (use Cart.totals for subtotal + shipping, but recompute fees here)
    const t = Cart.totals(); // { subtotal, shipping, fee, total, pct, flat }
    const subtotal = Number(t.subtotal || 0);  // banquets + addons + merch
    const shipping = Number(t.shipping || 0);  // product Shipping & Handling
    const baseForFees = subtotal + shipping;   // what Stripe actually uses

    // Compute processing fee so that, after Stripe takes (pct% + flat), you net the base.
// This "gross-up" formula avoids you paying out-of-pocket due to percentage-on-total math.
const pct = Number(t.pct || 0);
const flat = Number(t.flat || 0);
const baseCents = Math.round(baseForFees * 100);
const rate = pct / 100;
const flatCents = Math.round(flat * 100);

let feeCents = 0;
if (baseCents > 0 && (rate > 0 || flatCents > 0) && rate < 1) {
  const grossCents = Math.ceil((baseCents + flatCents) / (1 - rate));
  feeCents = Math.max(0, grossCents - baseCents);
}
const fee = feeCents / 100;

    // Purchaser country from the form (for intl preview)
    const pCountryEl = document.getElementById("p_country");
    const purchaserCountry = pCountryEl ? pCountryEl.value : "US";

    // International card fee is also applied on subtotal + shipping
    const intlFee = computeInternationalFeeDollars(
      baseForFees,
      purchaserCountry
    );

    const total = Number(subtotal + shipping + fee + intlFee);

    orderTotal.textContent = money(total);
    summaryBox.innerHTML = `
        <div><strong>Subtotal</strong>: ${money(subtotal)}</div>
        <div><strong>Shipping &amp; Handling</strong>: ${money(shipping)}</div>
        <div>Processing fee (card processing): ${money(fee)}</div>

        ${
          intlFee > 0
            ? `<div>International card processing fee (3%): ${money(intlFee)}</div>`
            : ""
        }
        <hr style="border:none;border-top:1px solid rgba(0,0,0,.15);margin:.5rem 0;">
        <div style="font-size:1.1em"><strong>Total (charged at checkout)</strong>: ${money(total)}</div>
        <p class="tiny" style="margin:.25rem 0 0;">
          The processing fees above are calculated on your entire order
          (banquets, Grand Court add-ons, merchandise, and shipping &amp; handling)
          and will be shown as separate line items on the secure Stripe checkout page.
          For cards issued outside the United States, the international card processing fee
          (if shown above) is also added as a separate line at checkout.
        </p>
      `;
  }

  // expose render for resync hooks
  window._orderRender = render;

  // --------- CHECKOUT / STRIPE WIRING ---------
  async function getStripeInstance() {
    // Ask router for publishable key (correct endpoint name)
    try {
      const r = await fetch("/api/router?type=stripe_pubkey", {
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.publishableKey) {
          return Stripe(j.publishableKey);
        }
      }
    } catch (e) {}

    // Fallback (safe to expose)
    if (window.STRIPE_PUBLISHABLE_KEY)
      return Stripe(window.STRIPE_PUBLISHABLE_KEY);

    throw new Error("Stripe publishable key not available.");
  }

  function readPurchaser() {
    const g = (id) => (document.getElementById(id)?.value || "").trim();
    return {
      name: g("p_name"),
      title: g("p_title"),
      email: g("p_email"),
      phone: g("p_phone"),
      address1: g("p_addr1"),
      address2: g("p_addr2"),
      city: g("p_city"),
      state: g("p_state"),
      postal: g("p_zip"),
      country: g("p_country") || "US",
    };
  }

  // Build payload (including shipping line)
  function buildPayloadFromCart() {
    const st = Cart.get() || { lines: [], attendees: [] };

    // quick attendee lookup
    const aMap = {};
    (st.attendees || []).forEach((a) => {
      aMap[a.id] = a;
    });

    const lines = (st.lines || []).map((l) => {
      const att = l.attendeeId ? aMap[l.attendeeId] : null;
      const isBanOrAddon =
        l.itemType === "banquet" || l.itemType === "addon";

      // Start with existing meta
      const meta = { ...(l.meta || {}) };

      // If this line belongs to a specific attendee, ensure identity fields
      if (isBanOrAddon && att) {
        if (!meta.attendeeName) meta.attendeeName = att.name || "";
        if (!meta.attendeeTitle) meta.attendeeTitle = att.title || "";
        if (!meta.attendeePhone) meta.attendeePhone = att.phone || "";
        if (!meta.attendeeEmail) meta.attendeeEmail = att.email || "";
        if (!meta.attendeeAddr1) meta.attendeeAddr1 = att.address1 || "";
        if (!meta.attendeeAddr2) meta.attendeeAddr2 = att.address2 || "";
        if (!meta.attendeeCity) meta.attendeeCity = att.city || "";
        if (!meta.attendeeState) meta.attendeeState = att.state || "";
        if (!meta.attendeePostal) meta.attendeePostal = att.postal || "";
        if (!meta.attendeeCountry)
          meta.attendeeCountry = att.country || "US";
        meta.attendeeCourtName = att.courtName || "";
        meta.attendeeCourtNumber = att.courtNumber || "";
        meta.attendeeMemberType = att.memberType || "";
      }

      // Make sure banquet notes follow our rule
      if (l.itemType === "banquet") {
        const attNotes = att && att.notes ? String(att.notes) : "";
        if (!meta.attendeeNotes && attNotes) meta.attendeeNotes = attNotes;
      }

      // Preserve bundle fields if present on the line
      const priceMode = l.priceMode || "";
      const bundleQty = l.bundleQty || "";
      const bundleTotalCents = l.bundleTotalCents || "";

      return {
        id: l.id,
        itemId: l.itemId,
        itemType: l.itemType,
        itemName: l.itemName,
        unitPrice: Number(normalizePrice(l.unitPrice)),
        qty: Number(l.qty || 1),
        attendeeId: l.attendeeId || "",
        priceMode,
        bundleQty,
        bundleTotalCents,
        meta,
      };
    });

    // Add a single Shipping & Handling line if needed
    const t = Cart.totals();
    const shippingDollars = Number(t.shipping || 0);
    if (shippingDollars > 0) {
      lines.push({
        id: "shipping",
        itemId: "shipping",
        itemType: "shipping",
        itemName: "Shipping & Handling",
        unitPrice: shippingDollars, // dollars; router converts to cents
        qty: 1,
        attendeeId: "",
        priceMode: "flat",
        bundleQty: "",
        bundleTotalCents: "",
        meta: {},
      });
    }

    // Only pass the fee config the router expects
    const fees = { pct: t.pct, flat: t.flat };
    return { lines, fees };
  }

  async function goToCheckout() {
    const btn = document.getElementById("checkout");
    const status = document.getElementById("checkoutStatus");
    const setStatus = (msg, ok) => {
      status.textContent = msg || "";
      status.className = ok ? "ok" : msg ? "err" : "";
    };

    try {
      setStatus("", false);
      btn.disabled = true;
      setStatus("Contacting payment server…", false);

      const purchaser = readPurchaser();

      // Strict client-side validation to match required fields
      const missing = [];
      if (!purchaser.name) missing.push("Full name");
      if (!looksLikeEmail(purchaser.email)) missing.push("Valid Email");
      if (!purchaser.phone) missing.push("Phone");
      if (!purchaser.title) missing.push("Title");
      if (!purchaser.address1) missing.push("Address line 1");
      if (!purchaser.city) missing.push("City");
      if (!purchaser.state) missing.push("State/Province");
      if (!purchaser.postal) missing.push("Postal code");
      if (!purchaser.country) missing.push("Country");

      if (missing.length) {
        throw new Error(
          "Please complete the following fields:\n• " + missing.join("\n• ")
        );
      }

      const needsCourtInfo = cartNeedsCourtInfo(Cart.get());
      const courtInfo = readCourtInfo(); // safe even if not needed

      if (needsCourtInfo) {
        const missingCourt = [];
        if (!courtInfo.name) missingCourt.push("Court name");
        if (!courtInfo.number) missingCourt.push("Court number");
        if (!courtInfo.organized) missingCourt.push("Date organized");
        if (!courtInfo.location) missingCourt.push("Location");

        if (missingCourt.length) {
          throw new Error(
            "Please complete the following court fields:\n• " +
              missingCourt.join("\n• ")
          );
        }
      }

      const payload = {
        purchaser,
        courtInfo,
        ...buildPayloadFromCart(),
        cancel_url: location.href, // snake_case for server
        cancelUrl: location.href, // camelCase also
      };

      // Create Checkout Session on your router
      const r = await fetch("/api/router?action=create_checkout_session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // IMPORTANT: read safely, even on 500/HTML/etc
      const j = await readJsonSafe(r);

      if (!r.ok) {
        // show best possible router reason (never "[object Object]")
        const msg = explainApiError(j) || "Payment server error";
        throw new Error(msg);
      }

      // Your router returns { url, id } — not { sessionId }
      if (j && j.url) {
        setStatus("Redirecting to Stripe…", true);
        window.location.href = j.url;
        return;
      }

      // Fallback: if URL not provided, use Stripe redirect with session id
      const stripe = await getStripeInstance();
      const sessionId = j.sessionId || j.id;
      if (!sessionId) throw new Error("Missing session id (and no checkout URL).");

      setStatus("Redirecting to Stripe…", true);
      const { error } = await stripe.redirectToCheckout({ sessionId });
      if (error) throw error;

    } catch (e) {
      console.error(e);
      setStatus(e?.message || "Checkout failed. Please try again.", false);
      const btn2 = document.getElementById("checkout");
      if (btn2) btn2.disabled = false;
    }
  }

  // --- DOM READY HOOK ---
  document.addEventListener("DOMContentLoaded", function () {
    Cart.load();
    // initial mirror of attendees
    syncAttendeesToStorageFromCart();

    // show/hide court info card based on current cart
    updateCourtInfoUI();

    // HOTFIX: migrate any legacy cents (once per load)
    (function migrateLegacyCents() {
      const st = Cart.get();
      let changed = false;
      (st.lines || []).forEach((l) => {
        const n = Number(l.unitPrice);
        if (isFinite(n) && n > 0 && n < 1) {
          l.unitPrice = Math.round(n * 100);
          changed = true;
        }
      });
      if (changed) {
        st.lines.forEach((line) =>
          Cart.updateLine(line.id, { unitPrice: line.unitPrice })
        );
      }
    })();

    // Purchaser phone auto-format (uses global formatPhoneLive from order.html)
    const pPhone = document.getElementById("p_phone");
    if (pPhone) {
      pPhone.addEventListener("input", () => formatPhoneLive(pPhone));
      pPhone.addEventListener("blur", () => formatPhoneLive(pPhone));
    }

    // Re-render when purchaser name changes (Purchaser group label)
    const pNameEl = document.getElementById("p_name");
    if (pNameEl) pNameEl.addEventListener("input", render);

    // Re-render when purchaser country changes (intl fee preview)
    const pCountryEl = document.getElementById("p_country");
    if (pCountryEl) {
      pCountryEl.addEventListener("input", render);
      pCountryEl.addEventListener("change", render);
    }

    // initial + react to cart changes
    render();
    window.addEventListener("cart:updated", function(){
      render();
      updateCourtInfoUI();
    });

    // Wire checkout button
    const btn = document.getElementById("checkout");
    if (btn) btn.addEventListener("click", goToCheckout);
  });

  // --- Auto-resync when returning to this tab or when storage changes ---
  function resyncFromStorage() {
    try {
      Cart.load();
    } catch (e) {}
    try {
      window._orderRender?.();
      syncAttendeesToStorageFromCart();
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) resyncFromStorage();
  });
  window.addEventListener("focus", resyncFromStorage);
  window.addEventListener("storage", function () {
    resyncFromStorage();
  });
})();