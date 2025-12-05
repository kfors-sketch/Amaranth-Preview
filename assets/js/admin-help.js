// /assets/js/admin-help.js
// Lightweight shared help-popup system for all admin pages.
(function () {
  "use strict";

  // --- Central help text registry -----------------------------------------
  // You can edit / expand this later without touching the logic.
  // Keys are the values you put in data-help-id on your buttons.
  const HELP_TEXT = {
    // Examples / placeholders — customize these later:
    banquets: `
      <p><strong>Banquet Manager</strong> lets you create and edit banquet events,
      prices, meal choices, and visibility windows. These items appear on the public
      registration pages when they are marked as active.</p>
      <ul>
        <li><strong>Status</strong>: Controls whether this banquet is visible to the public.</li>
        <li><strong>Dates</strong>: Limit when guests can register.</li>
        <li><strong>Chair email</strong>: Where detailed reports for this item are sent.</li>
      </ul>
    `,
    addons: `
      <p><strong>Add-Ons Manager</strong> manages optional items such as charms,
      pins, program books, and other extras. These can be attached to any order
      and will be included in reports sent to the assigned chair.</p>
    `,
    reporting_main: `
      <p><strong>Reporting Dashboard</strong> is the main hub for downloading CSV / Excel
      reports and sending scheduled email reports to chairs. Use this screen to see
      orders by item, by date range, and by attendee.</p>
    `,
    reporting_yoy: `
      <p><strong>Year-over-Year Reporting</strong> compares banquet registration and
      add-on performance across multiple years to help you see trends.</p>
    `,
    debug_tools: `
      <p><strong>Debug / Tools</strong> is intended for technical checks such as verifying
      email configuration, Stripe keys, KV access, and cron status. Use with caution.</p>
    `,
    // Fallback if you forget to define something:
    _default: `
      <p>No help text has been configured for this item yet.</p>
      <p>Please ask the site admin to update <code>HELP_TEXT</code> in
      <code>/assets/js/admin-help.js</code>.</p>
    `,
  };

  // Expose a tiny hook so you (or future scripts) can extend help from anywhere.
  // Example in the console:
  //   window.AdminHelp.register('my_new_id', '<p>Help text...</p>');
  const AdminHelp = {
    register(id, html) {
      if (!id) return;
      HELP_TEXT[id] = String(html || "");
    },
  };
  window.AdminHelp = AdminHelp;

  // --- DOM helpers ---------------------------------------------------------
  function ensureModal() {
    let modal = document.getElementById("adminHelpModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "adminHelpModal";
    modal.className = "help-modal hide";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="help-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="adminHelpTitle">
        <button type="button" class="help-close" aria-label="Close help">&times;</button>
        <h2 id="adminHelpTitle" class="help-title">Help</h2>
        <div class="help-modal-body"></div>
      </div>
    `;

    document.body.appendChild(modal);
    return modal;
  }

  function openHelpModal(id, overrideTitle) {
    const modal = ensureModal();
    const dialog = modal.querySelector(".help-modal-dialog");
    const body = modal.querySelector(".help-modal-body");
    const titleEl = modal.querySelector(".help-title");

    const html = HELP_TEXT[id] || HELP_TEXT._default || "";
    const title =
      overrideTitle ||
      guessTitleFromId(id) ||
      "Help";

    if (titleEl) {
      titleEl.textContent = title;
    }
    if (body) {
      body.innerHTML = html;
    }

    modal.classList.remove("hide");
    modal.setAttribute("aria-hidden", "false");
    // prevent background scroll while open
    document.body.classList.add("help-modal-open");

    // focus close button for keyboard users
    const closeBtn = modal.querySelector(".help-close");
    if (closeBtn) {
      closeBtn.focus();
    }
  }

  function closeHelpModal() {
    const modal = document.getElementById("adminHelpModal");
    if (!modal) return;
    modal.classList.add("hide");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("help-modal-open");
  }

  function guessTitleFromId(id) {
    if (!id) return "";
    // Turn "reporting_main" into "Reporting Main", etc.
    return String(id)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  // --- Event wiring --------------------------------------------------------

  // Delegate clicks for any .help-btn
  document.addEventListener("click", function (evt) {
    const btn = evt.target.closest(".help-btn");
    if (btn) {
      const id = btn.getAttribute("data-help-id") || "_default";
      const title =
        btn.getAttribute("data-help-title") ||
        btn.getAttribute("aria-label") ||
        btn.getAttribute("title") ||
        "";
      openHelpModal(id, title);
      evt.preventDefault();
      return;
    }

    // Close if clicking the close button
    if (evt.target.classList.contains("help-close")) {
      closeHelpModal();
      evt.preventDefault();
      return;
    }

    // Close if clicking on the backdrop (outside dialog)
    const modal = document.getElementById("adminHelpModal");
    if (modal && evt.target === modal) {
      closeHelpModal();
      evt.preventDefault();
      return;
    }
  });

  // Close on ESC key
  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape" || evt.key === "Esc") {
      const modal = document.getElementById("adminHelpModal");
      if (modal && !modal.classList.contains("hide")) {
        closeHelpModal();
      }
    }
  });
})();