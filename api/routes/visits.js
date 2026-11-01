// /api/routes/visits.js
import {
  REQ_OK,
  REQ_ERR,
  kv,
  kvGetSafe,
  kvSetSafe,
  kvSaddSafe,
  kvSmembersSafe,
  objectsToXlsxBuffer,
  getEffectiveOrderChannel,
} from "../admin/core.js";

import { requireAdminAuth } from "../lib/auth.js";
import { errResponse, getUrl, getRequestId } from "../lib/http.js";

// ============================================================================
// ✅ VISITS COUNTER (KV ground truth)
// - Public endpoint: POST /api/router?action=track_visit  (no auth)
// - Optional GET:    /api/router?type=track_visit&path=/home.html (no auth)
// - Admin endpoints:
//     GET /api/router?type=visits_summary&mode=auto|test|live_test|live&days=30
//     GET /api/router?type=visits_pages&mode=auto|test|live_test|live&days=30&limit=50
//     GET /api/router?type=visits_export&mode=auto|test|live_test|live&days=30   (xlsx)
// - Stores totals + per-day + per-month + per-path, split by channel (test/live_test/live)
// ============================================================================
const VISITS_KEY_PREFIX = "visits";

function ymdUtc(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function ymUtc(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function normalizeVisitPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "/";

  // strip protocol/host if someone passed full URL
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      return normalizeVisitPath(u.pathname || "/");
    }
  } catch {}

  const noQuery = raw.split("?")[0].split("#")[0].trim();
  let out = noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
  out = out.replace(/\/{2,}/g, "/");
  if (out.length > 256) out = out.slice(0, 256);
  return out || "/";
}

function shouldCountVisit(pathname) {
  const p = String(pathname || "").toLowerCase();
  if (!p) return false;

  // exclude API + admin + common debug pages
  if (p.startsWith("/api/")) return false;
  if (p.startsWith("/admin/")) return false;
  if (p.includes("debug")) return false;

  // exclude obvious assets
  if (
    p.startsWith("/assets/") ||
    p.endsWith(".js") ||
    p.endsWith(".css") ||
    p.endsWith(".png") ||
    p.endsWith(".jpg") ||
    p.endsWith(".jpeg") ||
    p.endsWith(".webp") ||
    p.endsWith(".gif") ||
    p.endsWith(".svg") ||
    p.endsWith(".ico") ||
    p.endsWith(".map")
  )
    return false;

  return true;
}

async function kvIncrSafe(key, delta = 1) {
  try {
    if (kv && typeof kv.incrby === "function") {
      return await kv.incrby(key, delta);
    }
    if (kv && typeof kv.incr === "function") {
      if (delta === 1) return await kv.incr(key);
      // fall through for non-1 deltas
    }
  } catch {}

  const prev = Number(await kvGetSafe(key, 0)) || 0;
  const next = prev + Number(delta || 0);
  await kvSetSafe(key, next);
  return next;
}

async function kvScardSafe(key, fallback = 0) {
  try {
    if (kv && typeof kv.scard === "function") {
      return await kv.scard(key);
    }
  } catch {}
  return fallback;
}

function visitsKey(mode, parts) {
  const m = String(mode || "test").trim().toLowerCase() || "test";
  return [VISITS_KEY_PREFIX, m, ...parts].join(":");
}

async function trackVisitInternal({ path, mode, now, vid }) {
  const pathname = normalizeVisitPath(path);
  if (!shouldCountVisit(pathname)) return { ok: true, skipped: true, path: pathname };

  const d = now || new Date();
  const day = ymdUtc(d);
  const month = ymUtc(d);

  // totals
  const kTotal = visitsKey(mode, ["total"]);
  const kDayTotal = visitsKey(mode, ["day", day, "total"]);
  const kMonthTotal = visitsKey(mode, ["month", month, "total"]);

  // per-path
  const safePathKey = encodeURIComponent(pathname);
  const kDayPath = visitsKey(mode, ["day", day, "path", safePathKey]);
  const kMonthPath = visitsKey(mode, ["month", month, "path", safePathKey]);

  // unique sets (optional)
  const visitor = String(vid || "").trim();
  const hasVisitor = visitor && visitor.length >= 6;
  const kDayUniqueSet = visitsKey(mode, ["day", day, "unique_set"]);
  const kDayPathUniqueSet = visitsKey(mode, ["day", day, "path", safePathKey, "unique_set"]);

  const ops = [
    kvIncrSafe(kTotal, 1),
    kvIncrSafe(kDayTotal, 1),
    kvIncrSafe(kMonthTotal, 1),
    kvSaddSafe(visitsKey(mode, ["pages"]), pathname),
    kvIncrSafe(kDayPath, 1),
    kvIncrSafe(kMonthPath, 1),
  ];

  if (hasVisitor) {
    ops.push(kvSaddSafe(kDayUniqueSet, visitor));
    ops.push(kvSaddSafe(kDayPathUniqueSet, visitor));
  }

  await Promise.all(ops);

  return { ok: true, path: pathname, day, month, mode };
}

// Admin helpers for visit reads
async function resolveVisitsMode(qMode) {
  const mode = String(qMode || "auto").trim().toLowerCase();
  const effectiveMode =
    mode === "auto"
      ? await getEffectiveOrderChannel().catch(() => "test")
      : mode;

  if (!["test", "live_test", "live"].includes(effectiveMode)) {
    return { ok: false, effectiveMode, error: "invalid-mode" };
  }
  return { ok: true, effectiveMode };
}

async function getVisitsDailyRows(effectiveMode, days) {
  const base = `visits:${effectiveMode}`;
  const rows = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const total = Number(await kvGetSafe(`${base}:day:${day}:total`, 0)) || 0;
    const unique = Number(await kvScardSafe(`${base}:day:${day}:unique_set`, 0)) || 0;
    rows.push({ day, total, unique });
  }
  return rows; // newest-first
}

async function getVisitsTopPages(effectiveMode, days) {
  const base = `visits:${effectiveMode}`;
  const pages = (await kvSmembersSafe(`${base}:pages`)) || [];
  const results = [];

  for (const page of pages) {
    const pagePath = normalizeVisitPath(page);
    const enc = encodeURIComponent(pagePath);

    let total = 0;
    let unique = 0;

    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      total += Number(await kvGetSafe(`${base}:day:${d}:path:${enc}`, 0)) || 0;
      unique += Number(await kvScardSafe(`${base}:day:${d}:path:${enc}:unique_set`, 0)) || 0;
    }

    if (total > 0) results.push({ page: pagePath, total, unique });
  }

  results.sort((a, b) => b.total - a.total);
  return results;
}




export async function handleVisitsGET(req, res) {
  if (req.method !== "GET") return false;

  const requestId = getRequestId(req);
  const url = getUrl(req);
  const q = Object.fromEntries(url.searchParams.entries());
  const type = url.searchParams.get("type");

  // ✅ Public: track a visit (no auth)
  if (type === "track_visit") {
    try {
      const pathParam =
        url.searchParams.get("path") ||
        url.searchParams.get("p") ||
        url.pathname ||
        "/";
      const mode = await getEffectiveOrderChannel().catch(() => "test");
      const vidParam =
        url.searchParams.get("vid") ||
        url.searchParams.get("visitorId") ||
        url.searchParams.get("v") ||
        "";
      const out = await trackVisitInternal({
        path: pathParam,
        mode,
        now: new Date(),
        vid: vidParam,
      });
      return REQ_OK(res, { requestId, ...out }), true;
    } catch (e) {
      // Visits must never break page load: return 200 and mark as not tracked.
      console.error("[visits] track_visit failed (ignored):", e);
      return REQ_OK(res, { requestId, ok: true, tracked: false, reason: "track-visit-failed" }), true;
    }
  }

  // Admin: summary
  if (type === "visits_summary") {
    if (!(await requireAdminAuth(req, res))) return true;

    try {
      const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
      const m = await resolveVisitsMode(q.mode);
      if (!m.ok) return REQ_ERR(res, 400, "invalid-mode", { requestId, mode: q.mode }), true;

      const rows = await getVisitsDailyRows(m.effectiveMode, days);
      return REQ_OK(res, { requestId, ok: true, mode: m.effectiveMode, days, rows }), true;
    } catch (e) {
      errResponse(res, 500, "visits-summary-failed", req, e);
      return true;
    }
  }

  // Admin: pages
  if (type === "visits_pages") {
    if (!(await requireAdminAuth(req, res))) return true;

    try {
      const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
      const limit = Math.max(1, Math.min(200, parseInt(q.limit || "50", 10) || 50));
      const m = await resolveVisitsMode(q.mode);
      if (!m.ok) return REQ_ERR(res, 400, "invalid-mode", { requestId, mode: q.mode }), true;

      const pages = await getVisitsTopPages(m.effectiveMode, days);
      return REQ_OK(res, { requestId, ok: true, mode: m.effectiveMode, days, pages: pages.slice(0, limit) }), true;
    } catch (e) {
      errResponse(res, 500, "visits-pages-failed", req, e);
      return true;
    }
  }

  // Admin: export
  if (type === "visits_export") {
    if (!(await requireAdminAuth(req, res))) return true;
    try {
      const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
      const m = await resolveVisitsMode(q.mode);
      if (!m.ok) return REQ_ERR(res, 400, "invalid-mode", { requestId, mode: q.mode }), true;

      const daily = await getVisitsDailyRows(m.effectiveMode, days);
      const topPages = await getVisitsTopPages(m.effectiveMode, days);

      const rows = [];
      rows.push({ section: "Daily Summary", day: "", page: "", total: "", unique: "" });
      for (const r of daily) rows.push({ section: "daily", day: r.day, page: "", total: r.total, unique: r.unique });

      rows.push({ section: "", day: "", page: "", total: "", unique: "" });
      rows.push({ section: "Top Pages (window totals)", day: "", page: "", total: "", unique: "" });
      for (const p of topPages) rows.push({ section: "page", day: "", page: p.page, total: p.total, unique: p.unique });

      const headers = ["section", "day", "page", "total", "unique"];
      const buf = await objectsToXlsxBuffer(headers, rows, [], "Visits");

      const filename = `visits_${m.effectiveMode}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.statusCode = 200;
      res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(buf);
      return true;
    } catch (e) {
      errResponse(res, 500, "visits-export-failed", req, e);
      return true;
    }
  }

  return false;
}

export async function handleVisitsPOST(req, res) {
  if (req.method !== "POST") return false;

  const url = getUrl(req);
  const action = url.searchParams.get("action");
  if (action !== "track_visit") return false;

  // NOTE: legacy supports POST action=track_visit. Keep it working here too.
  const requestId = getRequestId(req);
  try {
    const body = await (async () => {
      // safest: accept either JSON body with path/vid or empty
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const txt = Buffer.concat(chunks).toString("utf8") || "";
      if (!txt.trim()) return {};
      try { return JSON.parse(txt); } catch { return {}; }
    })();

    const pathParam = body.path || body.p || url.searchParams.get("path") || url.searchParams.get("p") || "/";
    const vidParam = body.vid || body.visitorId || body.v || url.searchParams.get("vid") || "";
    const mode = await getEffectiveOrderChannel().catch(() => "test");

    const out = await trackVisitInternal({ path: pathParam, mode, now: new Date(), vid: vidParam });
    REQ_OK(res, { requestId, ...out });
    return true;
  } catch (e) {
    // Visits must never break page load: return 200 and mark as not tracked.
    console.error("[visits] track_visit failed (ignored):", e);
    REQ_OK(res, { requestId, ok: true, tracked: false, reason: "track-visit-failed" });
    return true;
  }
}
