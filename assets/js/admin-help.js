// /assets/js/admin-help.js
// Shared help popup system for all admin pages
(function () {
  "use strict";

  console.log("[admin-help] script loaded");

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

  // Remember which button opened the modal (for focus return)
  let lastHelpTrigger = null;

  // Simple global hook you can call from HTML or console:
  function showAdminHelp(id, titleOverride, triggerEl) {
    const idSafe = id || "_default";
    if (triggerEl) {
      lastHelpTrigger = triggerEl;
    }
    openHelpModal(idSafe, titleOverride);
  }

  window.AdminHelp = {
    register(id, html) {
      if (!id) return;
      HELP_TEXT[id] = String(html || "");
    },
    show: showAdminHelp,
  };
  window.showAdminHelp = showAdminHelp;

  // -------------------------------------------------------------------------
  // CREATE/ENSURE MODAL ELEMENT (with built-in styling)
  // -------------------------------------------------------------------------
  function ensureModal() {
    let modal = document.getElementById("adminHelpModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "adminHelpModal";
    modal.className = "help-modal";

    modal.innerHTML = `
      <div class="help-modal-dialog" role="dialog">
        <button type="button" class="help-close" aria-label="Close help">&times;</button>
        <h2 class="help-title">Help</h2>
        <div class="help-modal-body"></div>
      </div>
    `;

    // Inline emergency styles so it always shows even if CSS is missing
    modal.style.position = "fixed";
    modal.style.left = "0";
    modal.style.top = "0";
    modal.style.right = "0";
    modal.style.bottom = "0";
    modal.style.padding = "1rem";
    modal.style.background = "rgba(15,23,42,0.55)";
    modal.style.display = "none"; // ⬅ start hidden
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = "9999";

    const dialog = modal.querySelector(".help-modal-dialog");
    if (dialog) {
      dialog.style.position = "relative";
      dialog.style.maxWidth = "480px";
      dialog.style.width = "100%";
      dialog.style.background = "#ffffff";
      dialog.style.borderRadius = "14px";
      dialog.style.boxShadow = "0 10px 40px rgba(15,23,42,0.40)";
      dialog.style.padding = "16px 18px 18px";
      dialog.style.fontFamily = "system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif";
      dialog.style.color = "#111827";
      dialog.style.fontSize = "14px";
    }

    const titleEl = modal.querySelector(".help-title");
    if (titleEl) {
      titleEl.style.margin = "0 0 6px 0";
      titleEl.style.fontSize = "16px";
      titleEl.style.fontWeight = "700";
    }

    const bodyEl = modal.querySelector(".help-modal-body");
    if (bodyEl) {
      bodyEl.style.marginTop = "4px";
      bodyEl.style.fontSize = "13px";
      bodyEl.style.lineHeight = "1.5";
      bodyEl.style.maxHeight = "60vh";
      bodyEl.style.overflow = "auto";
    }

    const closeBtn = modal.querySelector(".help-close");
    if (closeBtn) {
      closeBtn.style.position = "absolute";
      closeBtn.style.top = "6px";
      closeBtn.style.right = "8px";
      closeBtn.style.border = "none";
      closeBtn.style.background = "transparent";
      closeBtn.style.fontSize = "18px";
      closeBtn.style.cursor = "pointer";
      closeBtn.style.padding = "0";
    }

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

    if (titleEl) titleEl.textContent = title;
    if (body) body.innerHTML = html;

    // Show the modal
    modal.style.display = "flex";
    document.body.classList.add("help-modal-open");

    console.log("[admin-help] opened", id);

    // Move focus to the close button for keyboard users
    const closeBtn = modal.querySelector(".help-close");
    if (closeBtn) {
      closeBtn.focus();
    }
  }

  function closeHelpModal() {
    const modal = document.getElementById("adminHelpModal");
    if (!modal) return;

    // Blur whatever is currently focused
    if (document.activeElement && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Hide the modal
    modal.style.display = "none";
    document.body.classList.remove("help-modal-open");

    // Return focus to the button that opened it (if we know it)
    if (lastHelpTrigger && typeof lastHelpTrigger.focus === "function") {
      lastHelpTrigger.focus();
    }

    console.log("[admin-help] closed");
  }

  // -------------------------------------------------------------------------
  // CLICK HANDLERS (delegated)
  // -------------------------------------------------------------------------
  document.addEventListener("click", function (evt) {
    const btn = evt.target.closest && evt.target.closest(".help-btn");
    if (btn) {
      const id = btn.getAttribute("data-help-id") || "_default";
      const title =
        btn.getAttribute("data-help-title") ||
        btn.getAttribute("aria-label") ||
        "";
      lastHelpTrigger = btn;
      showAdminHelp(id, title, btn);
      evt.preventDefault();
      return;
    }

    if (evt.target.classList.contains("help-close")) {
      closeHelpModal();
      evt.preventDefault();
      return;
    }

    const modal = document.getElementById("adminHelpModal");
    if (modal && evt.target === modal) {
      // Clicked the dark backdrop
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
