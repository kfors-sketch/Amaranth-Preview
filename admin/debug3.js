// /admin/debugging3.js
// Debugging 3 — Safety Tools (client-side only)
// Requires router endpoints:
// - GET  /api/router?type=lockdown_status      (admin-only)
// - POST /api/router?action=set_lockdown      (admin-only)
// Optional (nice to have):
// - POST /api/router?action=debug_lockdown_write_test (admin-only)
// - GET  /api/router?type=debug_order_hash&oid=...    (admin-only recommended)
// - GET  /api/router?type=admin_log_tail&limit=...    (admin-only recommended)
// Existing helpful endpoints:
// - GET  /api/router?type=debug_order_preview&id=...
// - GET  /api/router?type=lastmail
// - GET  /api/router?type=settings (public ping)

(() => {
  "use strict";

  const LS_TOKEN_KEY = "amaranth_report_token";

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);

  function getToken() {
    return String(localStorage.getItem(LS_TOKEN_KEY) || "").trim();
  }

  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  function setPill(el, state, text) {
    if (!el) return;
    el.classList.remove("ok", "warn", "bad");
    el.classList.add(state);
    el.textContent = text;
  }

  function pretty(x) {
    try {
      return JSON.stringify(x, null, 2);
    } catch {
      return String(x);
    }
  }

  async function apiGet(path) {
    const r = await fetch(path, {
      method: "GET",
      headers: { ...authHeaders() },
    });
    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      j = { raw: txt };
    }
    return { ok: r.ok, status: r.status, json: j };
  }

  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(body || {}),
    });
    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      j = { raw: txt };
    }
    return { ok: r.ok, status: r.status, json: j };
  }

  function writeOut(el, obj) {
    if (!el) return;
    el.textContent = pretty(obj);
  }

  // ---------- actions ----------
  async function ping() {
    const authPill = $("authPill");
    const apiPill = $("apiPill");

    const hasToken = !!getToken();
    setPill(
      authPill,
      hasToken ? "ok" : "warn",
      hasToken ? "Auth: token found" : "Auth: missing token"
    );

    // public "settings" is a safe ping
    const r = await apiGet("/api/router?type=settings");
    setPill(
      apiPill,
      r.ok ? "ok" : "bad",
      r.ok ? `API: OK (${r.status})` : `API: ERR (${r.status})`
    );

    return r;
  }

  async function refreshLockdown() {
    const lockPill = $("lockPill");
    const out = $("lockOut");

    const r = await apiGet("/api/router?type=lockdown_status");
    writeOut(out, r);

    if (!r.ok) {
      setPill(lockPill, "bad", `Error ${r.status}`);
      return r;
    }

    const st = r.json?.lockdown || {};
    const on = !!st.on;

    setPill(lockPill, on ? "ok" : "warn", on ? "LOCKDOWN: ON" : "LOCKDOWN: OFF");

    // populate UI fields (nice UX)
    const msg = String(st.message || "").trim();
    const msgBox = $("lockMessage");
    if (msgBox && msg && !msgBox.value) msgBox.value = msg;

    const modeSel = $("lockMode");
    if (modeSel) modeSel.value = on ? "on" : "off";

    return r;
  }

  async function applyLockdown() {
    const modeSel = $("lockMode");
    const msgBox = $("lockMessage");

    const mode = modeSel ? modeSel.value : "off";
    const message = msgBox ? msgBox.value : "";

    const r = await apiPost("/api/router?action=set_lockdown", {
      on: mode === "on",
      message: String(message || "").trim(),
    });

    writeOut($("lockOut"), r);
    await refreshLockdown();
    return r;
  }

  async function lockdownWriteTest() {
    const r = await apiPost("/api/router?action=debug_lockdown_write_test", {});
    writeOut($("lockOut"), r);
    return r;
  }

  async function orderPreview() {
    const oidEl = $("oid");
    const oid = String(oidEl ? oidEl.value : "").trim();
    if (!oid) {
      alert("Enter an Order ID first.");
      return;
    }

    const r = await apiGet(
      `/api/router?type=debug_order_preview&id=${encodeURIComponent(oid)}`
    );
    writeOut($("orderOut"), r);
    return r;
  }

  async function orderHashVerify() {
    const oidEl = $("oid");
    const oid = String(oidEl ? oidEl.value : "").trim();
    if (!oid) {
      alert("Enter an Order ID first.");
      return;
    }

    const r = await apiGet(
      `/api/router?type=debug_order_hash&oid=${encodeURIComponent(oid)}`
    );
    writeOut($("orderOut"), r);
    return r;
  }

  async function lastMail() {
    const r = await apiGet("/api/router?type=lastmail");
    writeOut($("mailOut"), r);
    return r;
  }

  async function adminLogTail() {
    const limitEl = $("logLimit");
    const raw = Number(limitEl ? limitEl.value : 20);
    const limit = Math.max(1, Math.min(200, Number.isFinite(raw) ? raw : 20));

    const r = await apiGet(
      `/api/router?type=admin_log_tail&limit=${encodeURIComponent(String(limit))}`
    );
    writeOut($("adminLogOut"), r);
    return r;
  }

  // ---------- wire up ----------
  function wire() {
    const bind = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener("click", fn);
    };

    bind("btnPing", ping);
    bind("btnOpenAdmin", () => (location.href = "/admin/"));

    bind("btnRefreshLock", refreshLockdown);
    bind("btnApplyLock", applyLockdown);
    bind("btnWriteTest", lockdownWriteTest);

    bind("btnOrderPreview", orderPreview);
    bind("btnOrderHash", orderHashVerify);

    bind("btnLastMail", lastMail);
    bind("btnAdminLog", adminLogTail);
  }

  // ---------- init ----------
  async function init() {
    try {
      wire();
      await ping();
      await refreshLockdown(); // may 401 if token missing; that's fine
      await lastMail();
    } catch (e) {
      console.error("[debug3] init failed", e);
      // If page has an output area, show the error
      writeOut($("mailOut"), { ok: false, error: String(e?.message || e) });
    }
  }

  
  // ---------- Visits ----------
  function formatVisitsSummary(data) {
    if (!data || !data.days) return "No data";
    const lines = [];
    lines.push(`Mode: ${data.mode}`);
    lines.push(`Total (range): ${data.totalRange ?? ""}`);
    lines.push(`Unique (range): ${data.uniqueRange ?? ""}`);
    lines.push("");
    for (const d of data.days) {
      const date = d.date || "";
      const t = (d.total ?? "");
      const u = (d.unique ?? "");
      lines.push(`${date}  total=${t}  unique=${u}`);
    }
    return lines.join("\n");
  }

  function formatTopPages(data) {
    if (!data || !Array.isArray(data.pages)) return "No data";
    const lines = [];
    lines.push(`Top pages (range ${data.days ?? ""} days)`);
    lines.push("");
    for (const p of data.pages.slice(0, 25)) {
      lines.push(`${String(p.page).padEnd(32).slice(0,32)}  total=${p.total}  unique=${p.unique}`);
    }
    return lines.join("\n");
  }

  async function refreshVisits() {
    const modeEl = document.getElementById("visitsMode");
    const daysEl = document.getElementById("visitsDays");
    const outEl = document.getElementById("visitsOut");
    const topEl = document.getElementById("visitsTopOut");
    if (!modeEl || !daysEl || !outEl || !topEl) return;

    const mode = modeEl.value || "auto";
    const days = Math.max(1, Math.min(365, parseInt(daysEl.value || "30", 10) || 30));

    outEl.textContent = "Loading…";
    topEl.textContent = "Loading…";

    const qsMode = encodeURIComponent(mode);
    const qsDays = encodeURIComponent(String(days));

    const summary = await apiGet(`/api/router?type=visits_summary&mode=${qsMode}&days=${qsDays}`);
    const pages = await apiGet(`/api/router?type=visits_pages&mode=${qsMode}&days=${qsDays}&limit=50`);

    if (summary && summary.ok) outEl.textContent = formatVisitsSummary(summary.data);
    else outEl.textContent = `Error: ${summary && summary.error ? summary.error : "unknown"}`;

    if (pages && pages.ok) topEl.textContent = formatTopPages(pages.data);
    else topEl.textContent = `Error: ${pages && pages.error ? pages.error : "unknown"}`;
  }

  async function exportVisitsXlsx() {
    const modeEl = document.getElementById("visitsMode");
    const daysEl = document.getElementById("visitsDays");
    if (!modeEl || !daysEl) return;

    const mode = modeEl.value || "auto";
    const days = Math.max(1, Math.min(365, parseInt(daysEl.value || "30", 10) || 30));

    const url = `/api/router?type=visits_export&mode=${encodeURIComponent(mode)}&days=${encodeURIComponent(String(days))}`;

    const res = await fetch(url, { method: "GET", headers: authHeaders() });
    if (!res.ok) {
      alert(`Export failed: ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = `visits_${mode}_${days}d.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
  }

  function wireVisits() {
    const btn = document.getElementById("visitsRefresh");
    const exp = document.getElementById("visitsExport");
    if (btn) btn.addEventListener("click", () => refreshVisits());
    if (exp) exp.addEventListener("click", () => exportVisitsXlsx());
  }


// run
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
