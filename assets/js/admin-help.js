// /assets/js/admin-help.js
// Shared help popup system for all admin pages
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // HELP TEXT REGISTRY
  // Each key matches a data-help-id="..."
  // -------------------------------------------------------------------------
  const HELP_TEXT = {

    // -------------------------
    // Reporting Main Page
    // -------------------------

    reporting_main: `
      <p><strong>Reporting Dashboard</strong> gives you access to all orders,
      payments, exports, and automated chair reporting tools.</p>
      <p>The filters at the top affect most exported files and what you see in
      the table. Nothing you do here deletes server data — only your local 
      temporary copy.</p>
    `,

    reporting_orders: `
      <p><strong>Orders & Payments</strong> shows individual orders with their
      payment status, item purchased, buyer information, and amount paid.</p>
      <ul>
        <li><strong>Click any row</strong> to open the refund window.</li>
        <li>Status icons show Paid, Pending, or Refunded.</li>
        <li>The row count and totals update based on your filters.</li>
      </ul>
      <p>Use the “Rows shown” menu to limit visible rows for easier scrolling.</p>
    `,

    reporting_import: `
      <p><strong>Import & Export</strong> tools allow you to work offline.</p>
      <ul>
        <li>You can import a <code>.json</code> or <code>.csv</code> file to 
        temporarily load data — this does <strong>not</strong> overwrite server 
        data.</li>
        <li>“Export Filtered (.xlsx)” downloads a spreadsheet directly from the
        server, applying whatever filters you have set above.</li>
        <li>This section is safe to experiment with — you can always reload 
        fresh data from the server.</li>
      </ul>
    `,

    reporting_automation: `
      <p><strong>Automated Chair Reports</strong> send weekly email reports to the
      banquet, add-on, and catalog chairs.</p>
      <ul>
        <li>Choose the weekday you want reports sent.</li>
        <li>These reports contain <strong>per-item data</strong> for each chair’s
        assigned banquet or add-on.</li>
        <li>Saving updates both the dashboard and the server settings.</li>
      </ul>
      <p>The content of these weekly emails is identical to what chairs get when 
      you manually use “Email Chair(s)” in the Per-Item Tools section.</p>
    `,

    reporting_item_tools: `
      <p><strong>Per-item Tools</strong> allow you to download or email reports for
      a single banquet, add-on, or catalog product.</p>
      <ul>
        <li>Select a category, then choose the specific item.</li>
        <li><strong>Download .xlsx</strong> produces a spreadsheet filtered to 
        only that item.</li>
        <li><strong>Email Chair(s)</strong> sends the selected report to the 
        chair email(s) configured for that item.</li>
        <li>The “Email scope” menu lets you limit the email to:
          <ul>
            <li><strong>Full</strong> — all orders for that item</li>
            <li><strong>Current month</strong> — 1st to today</li>
            <li><strong>Custom range</strong> — your chosen dates</li>
          </ul>
        </li>
      </ul>
    `,

    reporting_totals: `
      <p><strong>Quick Totals</strong> give a fast summary of how many orders and 
      how much money each category produced inside your current filter window.</p>
      <ul>
        <li>Totals update automatically as you change the filters above.</li>
        <li>For exact accounting reports, use the exports at the top.</li>
        <li>This section is meant for quick reference and verifying trends.</li>
      </ul>
    `,

    // -------------------------
    // Fallback text
    // -------------------------
    _default: `
      <p>No help text has been configured for this item yet.</p>
      <p>Please ask the admin to update <code>HELP_TEXT</code> inside 
      <code>/assets/js/admin-help.js</code>.</p>
    `,
  };

  // Provide a global hook for future pages to add new help entries dynamically
  window.AdminHelp = {
    register(id, html) {
      if (!id) return;
      HELP_TEXT[id] = String(html || "");
    },
  };

  // -------------------------------------------------------------------------
  // CREATE/ENSURE MODAL ELEMENT
  // -------------------------------------------------------------------------
  function ensureModal() {
    let modal = document.getElementById("adminHelpModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "adminHelpModal";
    modal.className = "help-modal hide";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="help-modal-dialog" role="dialog" aria-modal="true">
        <button type="button" class="help-close" aria-label="Close help">&times;</button>
        <h2 class="help-title">Help</h2>
        <div class="help-modal-body"></div>
      </div>
    `;

    document.body.appendChild(modal);
    return modal;
  }

  function openHelpModal(id, overrideTitle) {
    const modal = ensureModal();
    const body = modal.querySelector(".help-modal-body");
    const titleEl = modal.querySelector(".help-title");

    const html = HELP_TEXT[id] || HELP_TEXT._default;
    const title =
      overrideTitle ||
      id.replace(/[_-]+/g, " ").replace(/\b\w/g, m => m.toUpperCase());

    titleEl.textContent = title;
    body.innerHTML = html;

    modal.classList.remove("hide");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("help-modal-open");
  }

  function closeHelpModal() {
    const modal = document.getElementById("adminHelpModal");
    if (!modal) return;
    modal.classList.add("hide");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("help-modal-open");
  }

  // -------------------------------------------------------------------------
  // CLICK HANDLERS
  // -------------------------------------------------------------------------
  document.addEventListener("click", function (evt) {
    // Open modal
    const btn = evt.target.closest(".help-btn");
    if (btn) {
      const id = btn.getAttribute("data-help-id") || "_default";
      const title =
        btn.getAttribute("data-help-title") ||
        btn.getAttribute("aria-label") ||
        "";
      openHelpModal(id, title);
      evt.preventDefault();
      return;
    }

    // Close modal
    if (evt.target.classList.contains("help-close")) {
      closeHelpModal();
      evt.preventDefault();
      return;
    }

    // Click outside the dialog closes
    const modal = document.getElementById("adminHelpModal");
    if (modal && evt.target === modal) {
      closeHelpModal();
      evt.preventDefault();
      return;
    }
  });

  // ESC key to close
  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape") {
      closeHelpModal();
    }
  });

})();