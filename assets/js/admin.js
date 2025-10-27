// /assets/js/admin.js  (pure JS; no <script> tags)

// =========== Admin Shared Helpers (banquets, addons, products) ===========

(function (global) {
  const Admin = {};

  // ---- Auth guard (redirects to login if not logged in) ----
  Admin.ensureAuth = function ensureAuth(loginPath = "/admin/reporting_login.html") {
    try {
      if (localStorage.getItem("amaranth_admin_pw_ok") !== "1") {
        location.replace(loginPath);
      }
    } catch {
      location.replace(loginPath);
    }
  };

  // ---- Logout helper ----
  Admin.attachLogout = function attachLogout(btnSelector, loginPath = "/admin/reporting_login.html") {
    const btn = document.querySelector(btnSelector);
    if (!btn) return;
    btn.addEventListener("click", () => {
      localStorage.removeItem("amaranth_admin_pw_ok");
      location.href = loginPath;
    });
  };

  // ---- Token header (for secured admin endpoints) ----
  Admin.tokenHeader = function tokenHeader() {
    const t = localStorage.getItem("amaranth_report_token");
    return t ? { Authorization: "Bearer " + t } : {};
  };

  // ---- Simple fetch wrappers ----
  Admin.apiGet = async function apiGet(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error((await safeJson(res))?.error || res.statusText);
    return res.json();
  };

  Admin.apiPostJSON = async function apiPostJSON(url, body) {
    const headers = { "Content-Type": "application/json", ...Admin.tokenHeader() };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json?.error || "Request failed");
    return json;
  };

  async function safeJson(res) {
    try { return await res.json(); } catch { return null; }
  }

  // ---- Load from server first; fallback to a global list (e.g., window.BANQUETS) ----
  // Usage: await Admin.loadModel({ apiPath: "/api/products", globalName: "PRODUCTS" })
  Admin.loadModel = async function loadModel({ apiPath, globalName }) {
    // 1) Try server
    try {
      const j = await Admin.apiGet(apiPath);
      const list = Array.isArray(j?.banquets) ? j.banquets
                 : Array.isArray(j?.addons)   ? j.addons
                 : Array.isArray(j?.products) ? j.products
                 : Array.isArray(j)           ? j
                 : [];
      if (list.length) return deepClone(list);
    } catch (e) {
      console.warn(`[admin] loadModel from ${apiPath} failed:`, e.message || e);
    }
    // 2) Fallback to static global
    const g = (globalName && global[globalName]) || [];
    return deepClone(Array.isArray(g) ? g : []);
  };

  // ---- Save model to secured admin API ----
  // Example: await Admin.saveModel("/api/admin/products", { products: model })
  Admin.saveModel = async function saveModel(apiPath, payload) {
    return Admin.apiPostJSON(apiPath, payload);
  };

  // ---- Export / Import helpers ----
  Admin.exportJSON = function exportJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  Admin.importJSON = function importJSON(fileInput, onLoaded) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const text = await file.text();
      try {
        const json = JSON.parse(text);
        onLoaded(json);
      } catch (err) {
        alert("Import failed: " + err.message);
      }
    });
  };

  // ---- Date helpers (match reporting pages) ----
  Admin.toLocalDT = function toLocalDT(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d)) return "";
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  };

  Admin.fromLocalDT = function fromLocalDT(v) {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d) ? "" : d.toISOString();
  };

  // ---- Misc helpers ----
  Admin.idOK = (id) => /^[a-z0-9-]+$/.test(id);
  Admin.esc = (s) => (s ?? "").toString().replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  Admin.setMsg = (el, text, ok) => { if(!el) return; el.textContent = text || ""; el.className = ok ? "ok" : (text ? "danger" : "muted"); };

  function deepClone(x){ return JSON.parse(JSON.stringify(x)); }

  // expose globally
  global.Admin = Admin;
})(window);
