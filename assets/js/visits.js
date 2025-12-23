// /assets/js/visits.js
// Lightweight client-side visit ping -> /api/router?action=track_visit
// - Skips admin/debug pages by default
// - Uses navigator.sendBeacon when available (non-blocking)
// - Falls back to fetch() with keepalive
(() => {
  try {
    const path = (location && location.pathname) ? String(location.pathname) : "/";
    const lower = path.toLowerCase();

    // Exclude admin + debug + assets by default (adjust if needed)
    if (lower.startsWith("/admin")) return;
    if (lower.includes("debug")) return;
    if (lower.startsWith("/api")) return;
    if (lower.startsWith("/assets")) return;

    // Optional: skip obvious non-content pages
    if (lower.includes("favicon")) return;

    const payload = {
      page: path,
      // keep ref lightweight; helps spot traffic sources
      ref: (document && document.referrer) ? String(document.referrer).slice(0, 400) : "",
      // lets server optionally do simple de-dupe for bounces
      ts: Date.now(),
      tz: Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : "",
    };

    const url = "/api/router?action=track_visit";

    const body = JSON.stringify(payload);

    if (navigator && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(url, blob);
      return;
    }

    // fallback
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch (_) {}
})();
