// /admin/debug2.js
// Advanced debug helpers for /admin/debug2.html

(function () {
  "use strict";

  const API_BASE = "/api/router";
  const TOKEN_KEY = "amaranth_report_token";

  // --- DOM refs ------------------------------------------------------------
  const authStatusEl = document.getElementById("authStatus2");
  const tokenWarningEl = document.getElementById("tokenWarning2");
  const outputEl = document.getElementById("output2");
  const outputStatusEl = document.getElementById("outputStatus2");

  const btnLoadSettings = document.getElementById("btnLoadSettings");

  const kvKeyPreset = document.getElementById("kvKeyPreset");
  const kvKeyInput = document.getElementById("kvKeyInput");
  const btnKvPeek = document.getElementById("btnKvPeek");

  const btnRunMonthly = document.getElementById("btnRunMonthly");
  const btnRunEndOfEvent = document.getElementById("btnRunEndOfEvent");

  const mailLimitInput = document.getElementById("mailLimit");
  const btnMailRecent = document.getElementById("btnMailRecent");

  const orderSearchQuery = document.getElementById("orderSearchQuery");
  const orderSearchLimit = document.getElementById("orderSearchLimit");
  const btnOrderSearch = document.getElementById("btnOrderSearch");

  const btnChairRouting = document.getElementById("btnChairRouting");

  const cfName = document.getElementById("cfName");
  const cfEmail = document.getElementById("cfEmail");
  const cfTopic = document.getElementById("cfTopic");
  const cfMessage = document.getElementById("cfMessage");
  const btnContactTest = document.getElementById("btnContactTest");

  const piPreviewId = document.getElementById("piPreviewId");
  const btnPiPreview = document.getElementById("btnPiPreview");

  const refundOrderId = document.getElementById("refundOrderId");
  const btnRefundPreview = document.getElementById("btnRefundPreview");

  // --- helpers -------------------------------------------------------------
  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function authHeaders() {
    const token = getToken();
    const h = {};
    if (token) h["Authorization"] = "Bearer " + token;
    return h;
  }

  function setButtonsDisabled(disabled) {
    const buttons = [
      btnLoadSettings,
      btnKvPeek,
      btnRunMonthly,
      btnRunEndOfEvent,
      btnMailRecent,
      btnOrderSearch,
      btnChairRouting,
      btnContactTest,
      btnPiPreview,
      btnRefundPreview,
    ];
    buttons.forEach((b) => {
      if (!b) return;
      b.disabled = disabled;
    });
  }

  function showJSON(label, data) {
    outputStatusEl.textContent = label ? " – " + label : "";
    outputStatusEl.classList.remove("status-bad");
    outputStatusEl.classList.add("status-ok");
    try {
      outputEl.textContent = JSON.stringify(data, null, 2);
    } catch {
      outputEl.textContent = String(data);
    }
  }

  function showError(label, err) {
    const msg =
      err && err.message
        ? err.message
        : typeof err === "string"
        ? err
        : "Unknown error";
    outputStatusEl.textContent = label ? " – " + label : " – Error";
    outputStatusEl.classList.remove("status-ok");
    outputStatusEl.classList.add("status-bad");
    outputEl.textContent = msg;
  }

  async function fetchJson(url, options, label) {
    setButtonsDisabled(true);
    outputStatusEl.classList.remove("status-bad");
    outputStatusEl.classList.add("status-ok");
    outputStatusEl.textContent = label ? " – " + label : "";
    outputEl.textContent = "";

    try {
      const res = await fetch(url, options || {});
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const errMsg =
          (data && (data.error || data.message)) ||
          "HTTP " + res.status;
        throw new Error(errMsg);
      }
      return data;
    } finally {
      setButtonsDisabled(false);
    }
  }

  // --- Actions -------------------------------------------------------------

  // Effective settings snapshot
  async function runLoadSettings() {
    try {
      const data = await fetchJson(
        API_BASE + "?action=get_settings",
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          body: "{}",
        },
        "Loading effective settings…"
      );
      showJSON("Effective settings snapshot", data);
    } catch (e) {
      showError("Settings error", e);
    }
  }

  // KV Peek
  function onKvPresetChange() {
    const val = kvKeyPreset.value || "";
    if (val && kvKeyInput) {
      kvKeyInput.value = val;
    }
  }

  async function runKvPeek() {
    const key = (kvKeyInput.value || "").trim();
    if (!key) {
      showError("KV Peek", "Please enter a KV key first.");
      return;
    }

    const qs =
      "?type=debug_kv_peek&key=" + encodeURIComponent(key);

    try {
      const data = await fetchJson(
        API_BASE + qs,
        {
          headers: {
            "Accept": "application/json",
            ...authHeaders(),
          },
        },
        "Loading KV key…"
      );
      showJSON("KV peek: " + key, data);
    } catch (e) {
      showError("KV Peek error", e);
    }
  }

  // Manual scheduler / cron
  async function runMonthlyReports() {
    try {
      const data = await fetchJson(
        API_BASE + "?action=send_monthly_chair_reports",
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          body: "{}",
        },
        "Running scheduled chair reports…"
      );
      showJSON("Scheduled chair reports result", data);
    } catch (e) {
      showError("Monthly reports error", e);
    }
  }

  async function runEndOfEventReports() {
    try {
      const data = await fetchJson(
        API_BASE + "?action=send_end_of_event_reports",
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          body: "{}",
        },
        "Running end-of-event reports…"
      );
      showJSON("End-of-event reports result", data);
    } catch (e) {
      showError("End-of-event reports error", e);
    }
  }

  // Mail log recent
  async function runMailRecent() {
    let limit = parseInt(mailLimitInput.value || "20", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;

    const qs =
      "?type=debug_mail_recent&limit=" + encodeURIComponent(limit);

    try {
      const data = await fetchJson(
        API_BASE + qs,
        {
          headers: {
            "Accept": "application/json",
            ...authHeaders(),
          },
        },
        "Loading recent mail log…"
      );
      showJSON("Mail log (recent " + limit + ")", data);
    } catch (e) {
      showError("Mail log error", e);
    }
  }

  // Order search
  async function runOrderSearch() {
    const q = (orderSearchQuery.value || "").trim();
    if (!q) {
      showError("Order search", "Please enter a search query.");
      return;
    }

    let limit = parseInt(orderSearchLimit.value || "20", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;

    const qs =
      "?type=debug_find_orders&q=" +
      encodeURIComponent(q) +
      "&limit=" +
      encodeURIComponent(limit);

    try {
      const data = await fetchJson(
        API_BASE + qs,
        {
          headers: {
            "Accept": "application/json",
            ...authHeaders(),
          },
        },
        "Searching orders…"
      );
      showJSON("Order search: " + q, data);
    } catch (e) {
      showError("Order search error", e);
    }
  }

  // Chair routing snapshot
  async function runChairRouting() {
    // Prefer a dedicated debug_chair_routing handler if implemented.
    const qs = "?type=debug_chair_routing";

    try {
      const data = await fetchJson(
        API_BASE + qs,
        {
          headers: {
            "Accept": "application/json",
            ...authHeaders(),
          },
        },
        "Loading chair routing…"
      );
      showJSON("Chair routing snapshot", data);
    } catch (e) {
      showError("Chair routing error", e);
    }
  }

  // Contact form simulator
  async function runContactTest() {
    const name = (cfName.value || "").trim() || "Debug Test User";
    const email = (cfEmail.value || "").trim();
    const topic = (cfTopic.value || "website").trim() || "website";
    const messageRaw = (cfMessage.value || "").trim();

    if (!email) {
      showError("Contact test", "Please enter an email address.");
      return;
    }

    const message =
      "[DEBUG2] Test message from /admin/debug2.html\n\n" +
      (messageRaw || "(no extra message)");

    const body = {
      name,
      email,
      phone: "",
      topic,
      page: "debug2",
      item: "",
      message,
    };

    try {
      const data = await fetchJson(
        API_BASE + "?action=contact_form",
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        "Sending contact test…"
      );
      showJSON("Contact form test result", data);
    } catch (e) {
      showError("Contact test error", e);
    }
  }

  // Stripe PaymentIntent preview
  async function runPiPreview() {
    const id = (piPreviewId.value || "").trim();
    if (!id) {
      showError("PI preview", "Please enter a PaymentIntent ID.");
      return;
    }

    const qs =
      "?type=debug_pi_preview&pi_id=" + encodeURIComponent(id);

    try {
      const data = await fetchJson(
        API_BASE + qs,
        {
          headers: {
            "Accept": "application/json",
            ...authHeaders(),
          },
        },
        "Loading PaymentIntent…"
      );
      showJSON("PaymentIntent preview: " + id, data);
    } catch (e) {
      showError("PaymentIntent preview error", e);
    }
  }

  // Order + refunds preview
  async function runRefundPreview() {
    const oid = (refundOrderId.value || "").trim();
    if (!oid) {
      showError("Refund preview", "Please enter an order ID.");
      return;
    }

    const qs =
      "?type=debug_order_refunds&id=" + encodeURIComponent(oid);

    try {
      const data = await fetchJson(
        API_BASE + qs,
        {
          headers: {
            "Accept": "application/json",
            ...authHeaders(),
          },
        },
        "Loading order + refunds…"
      );
      showJSON("Order + refunds for " + oid, data);
    } catch (e) {
      showError("Refund preview error", e);
    }
  }

  // --- Wire up events ------------------------------------------------------
  if (btnLoadSettings) {
    btnLoadSettings.addEventListener("click", runLoadSettings);
  }
  if (kvKeyPreset) {
    kvKeyPreset.addEventListener("change", onKvPresetChange);
  }
  if (btnKvPeek) {
    btnKvPeek.addEventListener("click", runKvPeek);
  }
  if (btnRunMonthly) {
    btnRunMonthly.addEventListener("click", runMonthlyReports);
  }
  if (btnRunEndOfEvent) {
    btnRunEndOfEvent.addEventListener("click", runEndOfEventReports);
  }
  if (btnMailRecent) {
    btnMailRecent.addEventListener("click", runMailRecent);
  }
  if (btnOrderSearch) {
    btnOrderSearch.addEventListener("click", runOrderSearch);
  }
  if (btnChairRouting) {
    btnChairRouting.addEventListener("click", runChairRouting);
  }
  if (btnContactTest) {
    btnContactTest.addEventListener("click", runContactTest);
  }
  if (btnPiPreview) {
    btnPiPreview.addEventListener("click", runPiPreview);
  }
  if (btnRefundPreview) {
    btnRefundPreview.addEventListener("click", runRefundPreview);
  }

  // --- Init auth status ----------------------------------------------------
  (function initAuthStatus() {
    const token = getToken();
    if (token) {
      authStatusEl.innerHTML =
        'Admin token: <span class="status-ok">present</span>';
      tokenWarningEl.style.display = "none";
    } else {
      authStatusEl.innerHTML =
        'Admin token: <span class="status-bad">missing</span>';
      tokenWarningEl.style.display = "block";
    }
  })();

  /* -------------------------------------------------------------------------- */
  /* Supplies / Cart debug                                                       */
  /* -------------------------------------------------------------------------- */

  const btnLoadSuppliesScript = document.getElementById("btnLoadSuppliesScript");
  const btnShowSuppliesLocal = document.getElementById("btnShowSuppliesLocal");
  const btnShowSuppliesApi = document.getElementById("btnShowSuppliesApi");
  const cartKeyInput = document.getElementById("cartKeyInput");
  const btnDumpCart = document.getElementById("btnDumpCart");
  const btnListCartKeys = document.getElementById("btnListCartKeys");

  function guessCartKeys() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const kl = String(k).toLowerCase();
        if (kl.includes("cart") || kl.includes("order") || kl.includes("checkout")) {
          keys.push(k);
        }
      }
    } catch {}
    // common fallbacks
    ["amaranth_cart", "cart", "amaranthCart", "order_cart", "orderCart"].forEach((k) => {
      if (!keys.includes(k)) keys.push(k);
    });
    return keys;
  }

  async function loadSuppliesScriptOnce() {
    if (Array.isArray(window.SUPPLIES_ITEMS) && window.SUPPLIES_ITEMS.length) {
      return { alreadyLoaded: true, count: window.SUPPLIES_ITEMS.length };
    }
    return await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/assets/js/supplies.js?v=" + Date.now();
      s.async = true;
      s.onload = () => resolve({ loaded: true, count: (window.SUPPLIES_ITEMS || []).length });
      s.onerror = () => reject(new Error("Failed to load /assets/js/supplies.js"));
      document.head.appendChild(s);
    });
  }

  async function runLoadSuppliesScript() {
    try {
      const r = await loadSuppliesScriptOnce();
      showJSON("Loaded supplies.js", {
        ...r,
        hasSUPPLIES_ITEMS: Array.isArray(window.SUPPLIES_ITEMS),
      });
    } catch (e) {
      showError("Load supplies.js error", e);
    }
  }

  function runShowSuppliesLocal() {
    const items = Array.isArray(window.SUPPLIES_ITEMS) ? window.SUPPLIES_ITEMS : [];
    const act = items.filter((x) => x && x.active !== false);
    const cats = {};
    act.forEach((it) => {
      const c = String(it.category || "Uncategorized");
      cats[c] = (cats[c] || 0) + 1;
    });

    showJSON("SUPPLIES_ITEMS (client)", {
      total: items.length,
      activeNow: act.length,
      categories: cats,
      sample: act.slice(0, 15).map((x) => ({ id: x.id, name: x.name, price: x.price, active: x.active })),
    });
  }

  async function runShowSuppliesApi() {
    try {
      const data = await fetchJson(
        API_BASE + "?type=catalog_items&cat=supplies",
        { headers: { Accept: "application/json" } },
        "Loading catalog_items (supplies)…"
      );

      const items = Array.isArray(data?.items) ? data.items : [];
      showJSON("API catalog_items (supplies)", {
        ok: data?.ok ?? true,
        count: items.length,
        sample: items.slice(0, 20).map((x) => ({ id: x.id, name: x.name, active: x.active, price: x.price })),
        raw: data,
      });
    } catch (e) {
      showError("catalog_items error", e);
    }
  }

  function runDumpCart() {
    const key = String(cartKeyInput?.value || "").trim() || "amaranth_cart";
    let raw = null;
    let parsed = null;
    try { raw = localStorage.getItem(key); } catch {}
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }

    showJSON("Cart dump", {
      key,
      exists: raw != null,
      rawType: typeof raw,
      parsed,
    });
  }

  function runListCartKeys() {
    const keys = guessCartKeys();
    showJSON("Likely cart keys", { keys });
    if (cartKeyInput && !cartKeyInput.value && keys.length) {
      cartKeyInput.value = keys[0];
    }
  }



  // Wire Supplies / Cart debug buttons
  if (cartKeyInput && !cartKeyInput.value) cartKeyInput.value = "amaranth_cart";
  if (btnLoadSuppliesScript) btnLoadSuppliesScript.addEventListener("click", runLoadSuppliesScript);
  if (btnShowSuppliesLocal) btnShowSuppliesLocal.addEventListener("click", runShowSuppliesLocal);
  if (btnShowSuppliesApi) btnShowSuppliesApi.addEventListener("click", runShowSuppliesApi);
  if (btnDumpCart) btnDumpCart.addEventListener("click", runDumpCart);
  if (btnListCartKeys) btnListCartKeys.addEventListener("click", runListCartKeys);

})();
