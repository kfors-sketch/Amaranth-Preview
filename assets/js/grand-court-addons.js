// assets/js/grand-court-addons.js
(function () {
  // ====== Add-on catalog (with chair + publish window placeholders) ======
  // Add or edit items here. IDs must be stable (used for reporting).
  window.GRAND_COURT_ADDONS = [
    {
      id: "pre-reg",
      name: "Pre-Registration",
      type: "fixed",             // fixed | qty | amount | variantQty
      price: 30,                 // dollars
      limitPerAttendee: 1,
      chair: { name: "TBD", email: "mrskfors@yahoo.com" },
      chairEmails: ["mrskfors@yahoo.com"],
      publishStart: "",          // e.g. "2026-01-01T00:00:00-05:00"
      publishEnd: ""
    },
    {
      id: "directory",
      name: "Printed Directory",
      type: "qty",
      price: 15,
      chair: { name: "TBD", email: "tbd@example.com" },
      chairEmails: ["tbd@example.com"],
      publishStart: "",
      publishEnd: ""
    },
    {
      id: "love-gift",
      name: "Love Gift",
      type: "amount",
      minAmount: 0.01,           // USD
      chair: { name: "TBD", email: "mrskfors@yahoo.com" },
      chairEmails: ["mrskfors@yahoo.com"],
      publishStart: "",
      publishEnd: ""
    },
    {
      id: "addenda",
      name: "Addenda",
      type: "qty",
      price: 5,
      chair: { name: "TBD", email: "tbd@example.com" },
      chairEmails: ["tbd@example.com"],
      publishStart: "",
      publishEnd: ""
    },
    {
      id: "corsage",
      name: "Corsage",
      type: "variantQty",        // variant + optional custom + qty
      price: 15,
      variants: ["Red Roses","Pink Roses","Yellow Roses","Spring Flowers","Custom"],
      chair: { name: "TBD", email: "mrskfors@yahoo.com" },
      chairEmails: ["mrskfors@yahoo.com"],
      publishStart: "",
      publishEnd: ""
    }
  ];

  // ====== Helpers ======
  function money(n) {
    const v = Math.max(0.01, Math.round(Number(n) * 100) / 100);
    return v.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2
    });
  }
  function dollars(n) {
    return Math.round(Number(n || 0) * 100) / 100;
  }

  // ====== Attendees + Add-ons UI (only on the PUBLIC add-ons page) ======
  document.addEventListener("DOMContentLoaded", function () {
    // Guard: if Cart or the expected elements are missing, we’re probably
    // on an admin page (like admin/addons.html). Skip all Cart logic there.
    if (!window.Cart) return;

    const list = document.getElementById("attendees");
    const form = document.getElementById("attForm");
    const grid = document.getElementById("addonsGrid");

    if (!list || !form || !grid) {
      // Not the front-facing Add-Ons page; do nothing here.
      return;
    }

    Cart.load();

    function renderAttendees() {
      const st = Cart.get();
      list.innerHTML = (st.attendees || [])
        .map(
          (a) => `
        <div class="att-card">
          <strong>${a.name || ""}</strong>
          <small>${a.email || ""}</small>
          <em>${a.title || ""}</em>
          <button data-del="${a.id}">Remove</button>
        </div>
      `
        )
        .join("");

      list.querySelectorAll("button[data-del]").forEach((btn) => {
        btn.onclick = () => {
          Cart.removeAttendee(btn.dataset.del);
          renderAttendees();
          refreshAttSelects();
        };
      });
    }

    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      Cart.addAttendee({
        name: fd.get("name"),
        email: fd.get("email"),
        title: fd.get("title")
      });
      form.reset();
      renderAttendees();
      refreshAttSelects();
    };

    renderAttendees();

    function fillSelect(sel) {
      const a = (Cart.get().attendees) || [];
      sel.innerHTML = "";
      if (!a.length) {
        sel.disabled = true;
        sel.innerHTML = '<option value="">Add attendee first</option>';
      } else {
        sel.disabled = false;
        sel.innerHTML =
          '<option value="" disabled selected>Select attendee…</option>' +
          a.map((x) => `<option value="${x.id}">${x.name || x.email}</option>`).join("");
      }
    }

    function refreshAttSelects() {
      document.querySelectorAll(".addon .att-select").forEach(fillSelect);
    }

    // ====== Render Add-on Cards from the catalog above ======
    function renderAddonCard(addon) {
      // Build inner controls based on addon.type
      let controls = "";
      if (addon.type === "fixed") {
        controls = `
          <div class="row">
            <label>Assign to
              <select class="att-select"></select>
            </label>
            <button class="btn act-add" data-id="${addon.id}">Add</button>
          </div>`;
      } else if (addon.type === "qty") {
        controls = `
          <div class="row">
            <label>Assign to
              <select class="att-select"></select>
            </label>
            <label>Quantity
              <input type="number" min="1" step="1" value="1" class="qty">
            </label>
            <button class="btn act-add" data-id="${addon.id}">Add</button>
          </div>`;
      } else if (addon.type === "amount") {
        controls = `
          <div class="row">
            <label>Assign to
              <select class="att-select"></select>
            </label>
            <label>Amount (USD)
              <input type="number" min="${addon.minAmount || 0.01}" step="0.01"
                     value="${addon.minAmount || 0}" inputmode="decimal" class="amt">
            </label>
            <label>Notes (optional)
              <input type="text" class="notes" placeholder="Message or instruction">
            </label>
            <button class="btn act-add" data-id="${addon.id}">Add</button>
          </div>`;
      } else if (addon.type === "variantQty") {
        const options = (addon.variants || [])
          .map((v) => `<option value="${v}">${v}</option>`)
          .join("");
        controls = `
          <div class="row">
            <label>Assign to
              <select class="att-select"></select>
            </label>
            <label>Type
              <select class="variant">${options}</select>
            </label>
            <label>Custom text (optional)
              <input type="text" class="custom-text" placeholder="Describe request">
            </label>
            <label>Quantity
              <input type="number" min="1" step="1" value="1" class="qty">
            </label>
            <button class="btn act-add" data-id="${addon.id}">Add</button>
          </div>`;
      }

      const priceLabel =
        addon.type === "amount" ? "Custom Amount" : money(addon.price || 0);

      const limitNote = addon.limitPerAttendee
        ? `<p class="tiny">Optional. Limit ${addon.limitPerAttendee} per attendee.</p>`
        : "";

      return `
        <div class="card addon" data-addon="${addon.id}">
          <h3>${addon.name} — <span class="price">${priceLabel}</span></h3>
          ${limitNote}
          ${controls}
        </div>`;
    }

    function renderAddons() {
      grid.innerHTML = (window.GRAND_COURT_ADDONS || [])
        .map(renderAddonCard)
        .join("");
      refreshAttSelects();

      // Wire all "Add" buttons
      grid.querySelectorAll(".act-add").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const id = btn.getAttribute("data-id");
          const card = btn.closest(".addon");
          const addon = (window.GRAND_COURT_ADDONS || []).find((a) => a.id === id);
          if (!addon) return;

          const attSel = card.querySelector(".att-select");
          const attendeeId = attSel && attSel.value ? attSel.value : null;
          if (!attendeeId) {
            alert("Please select an attendee first.");
            return;
          }

          // Enforce limit per attendee for "fixed"
          if (addon.type === "fixed" && addon.limitPerAttendee) {
            const st = Cart.get();
            const already = (st.lines || []).some(
              (l) =>
                l.attendeeId === attendeeId &&
                l.itemType === "addon" &&
                l.itemId === addon.id
            );
            if (already) {
              alert(`${addon.name} already added for this attendee.`);
              return;
            }
          }

          // Build line based on addon.type
          if (addon.type === "fixed") {
            Cart.addLine({
              attendeeId,
              itemType: "addon",
              itemId: addon.id,
              itemName: addon.name,
              qty: 1,
              unitPrice: addon.price,
              meta: { variant: "", notes: "" }
            });
          } else if (addon.type === "qty") {
            const qty = Math.max(
              1,
              parseInt(card.querySelector(".qty").value || "1", 10)
            );
            Cart.addLine({
              attendeeId,
              itemType: "addon",
              itemId: addon.id,
              itemName: addon.name,
              qty,
              unitPrice: addon.price,
              meta: { variant: "", notes: "" }
            });
          } else if (addon.type === "amount") {
            const amt = dollars(card.querySelector(".amt").value || 0);
            const min = Number(addon.minAmount || 0.01);
            const notes = card.querySelector(".notes").value || "";
            if (!isFinite(amt) || amt < min) {
              alert(`Enter an amount ≥ ${min}.`);
              return;
            }
            Cart.addLine({
              attendeeId,
              itemType: "addon",
              itemId: addon.id,
              itemName: addon.name,
              qty: 1,
              unitPrice: amt,
              meta: { variant: "", notes }
            });
          } else if (addon.type === "variantQty") {
            const variant = card.querySelector(".variant").value;
            const custom = card.querySelector(".custom-text").value || "";
            const qty = Math.max(
              1,
              parseInt(card.querySelector(".qty").value || "1", 10)
            );
            const name =
              custom && variant === "Custom"
                ? `${addon.name} (Custom)`
                : `${addon.name} (${variant})`;
            const notes = custom || "";
            const itemId =
              variant === "Custom"
                ? `${addon.id}:custom`
                : `${addon.id}:${variant.toLowerCase().replace(/\s+/g, "-")}`;

            Cart.addLine({
              attendeeId,
              itemType: "addon",
              itemId,
              itemName: name,
              qty,
              unitPrice: addon.price,
              meta: { variant, notes }
            });
          }

          alert(`${addon.name} added`);
        });
      });
    }

    // Initial render + keep selects fresh on cart changes.
    renderAddons();
    window.addEventListener("cart:updated", () => {
      renderAttendees();
      refreshAttSelects();
    });
  });
})();

// ====== Auto-register metadata for email reports (banquets/addons) ======
(function () {
  try {
    (window.GRAND_COURT_ADDONS || []).forEach((item) => {
      const payload = {
        id: item.id,
        name: item.name,
        chairEmails: Array.isArray(item.chairEmails)
          ? item.chairEmails
          : [item?.chair?.email].filter(Boolean),
        publishStart: item.publishStart || "",
        publishEnd: item.publishEnd || "" // used as "ordering closes" for FINAL report
      };
      fetch("/api/router?action=register_item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    });
  } catch (e) {
    console.warn("[addons] auto-register failed:", e);
  }
})();
