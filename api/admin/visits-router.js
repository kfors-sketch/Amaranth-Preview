// /api/admin/visits-router.js
// Visit tracking/reporting routes split out of api/router.js.

import {
  kv,
  kvGetSafe,
  kvSetSafe,
  kvSaddSafe,
  kvSmembersSafe,
  getEffectiveOrderChannel,
  REQ_OK,
  REQ_ERR,
  objectsToXlsxBuffer,
} from "./core.js";

const VISITS_KEY_PREFIX = "visits";

function ymdUtc(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function ymUtc(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function normalizeVisitPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "/";

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
  if (p.startsWith("/api/")) return false;
  if (p.startsWith("/admin/")) return false;
  if (p.includes("debug")) return false;
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
  ) return false;
  return true;
}

async function kvIncrSafe(key, delta = 1) {
  try {
    if (kv && typeof kv.incrby === "function") return await kv.incrby(key, delta);
    if (kv && typeof kv.incr === "function") {
      if (delta === 1) return await kv.incr(key);
    }
  } catch {}

  const prev = Number(await kvGetSafe(key, 0)) || 0;
  const next = prev + Number(delta || 0);
  await kvSetSafe(key, next);
  return next;
}

async function kvScardSafe(key, fallback = 0) {
  try {
    if (kv && typeof kv.scard === "function") return await kv.scard(key);
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
  const safePathKey = encodeURIComponent(pathname);

  const visitor = String(vid || "").trim();
  const hasVisitor = visitor && visitor.length >= 6;

  const ops = [
    kvIncrSafe(visitsKey(mode, ["total"]), 1),
    kvIncrSafe(visitsKey(mode, ["day", day, "total"]), 1),
    kvIncrSafe(visitsKey(mode, ["month", month, "total"]), 1),
    kvSaddSafe(visitsKey(mode, ["pages"]), pathname),
    kvIncrSafe(visitsKey(mode, ["day", day, "path", safePathKey]), 1),
    kvIncrSafe(visitsKey(mode, ["month", month, "path", safePathKey]), 1),
  ];

  if (hasVisitor) {
    ops.push(kvSaddSafe(visitsKey(mode, ["day", day, "unique_set"]), visitor));
    ops.push(kvSaddSafe(visitsKey(mode, ["day", day, "path", safePathKey, "unique_set"]), visitor));
  }

  await Promise.all(ops);
  return { ok: true, path: pathname, day, month, mode };
}

async function resolveVisitsMode(qMode) {
  const modeRaw = String(qMode || "auto").trim().toLowerCase();
  const effectiveMode = modeRaw === "auto"
    ? await getEffectiveOrderChannel().catch(() => "test")
    : modeRaw;

  if (!["test", "live_test", "live"].includes(effectiveMode)) {
    return { ok: false, modeRaw, effectiveMode };
  }
  return { ok: true, modeRaw, effectiveMode };
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
  return rows;
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
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      total += Number(await kvGetSafe(`${base}:day:${day}:path:${enc}`, 0)) || 0;
      unique += Number(await kvScardSafe(`${base}:day:${day}:path:${enc}:unique_set`, 0)) || 0;
    }

    if (total > 0) results.push({ page: pagePath, total, unique });
  }

  results.sort((a, b) => b.total - a.total);
  return results;
}

export async function handleVisitsRoute(req, res, ctx = {}) {
  const {
    url,
    type,
    action,
    body = {},
    requestId = "",
    requireAdminAuth,
    errResponse,
  } = ctx;

  const method = String(req?.method || "GET").toUpperCase();

  if (method === "GET" && type === "track_visit") {
    try {
      const pathParam = url.searchParams.get("path") || url.searchParams.get("p") || url.pathname || "/";
      const mode = await getEffectiveOrderChannel().catch(() => "test");
      const vidParam = url.searchParams.get("vid") || url.searchParams.get("visitorId") || url.searchParams.get("v") || "";
      const out = await trackVisitInternal({ path: pathParam, mode, now: new Date(), vid: vidParam });
      REQ_OK(res, { requestId, ...out });
      return true;
    } catch (e) {
      errResponse(res, 500, "track-visit-failed", req, e);
      return true;
    }
  }

  if (method === "POST" && action === "track_visit") {
    try {
      const pathParam = String(body?.path || body?.pathname || "") || String(url.searchParams.get("path") || url.searchParams.get("p") || "");
      const fallbackPath = url.pathname || "/";
      const mode = await getEffectiveOrderChannel().catch(() => "test");
      const vidParam = String(body?.vid || body?.visitorId || body?.v || "") || String(url.searchParams.get("vid") || url.searchParams.get("visitorId") || url.searchParams.get("v") || "");
      const out = await trackVisitInternal({ path: pathParam || fallbackPath, mode, now: new Date(), vid: vidParam });
      REQ_OK(res, { requestId, ...out });
      return true;
    } catch (e) {
      errResponse(res, 500, "track-visit-failed", req, e);
      return true;
    }
  }

  if (method !== "GET") return false;

  if (type === "visits_summary") {
    if (!(await requireAdminAuth(req, res))) return true;
    const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "30", 10) || 30));
    const m = await resolveVisitsMode(url.searchParams.get("mode") || "auto");
    if (!m.ok) {
      REQ_ERR(res, 400, "invalid-mode", { requestId, mode: m.modeRaw });
      return true;
    }
    const rows = await getVisitsDailyRows(m.effectiveMode, days);
    REQ_OK(res, { requestId, ok: true, mode: m.effectiveMode, days, rows });
    return true;
  }

  if (type === "visits_pages") {
    if (!(await requireAdminAuth(req, res))) return true;
    const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "30", 10) || 30));
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const m = await resolveVisitsMode(url.searchParams.get("mode") || "auto");
    if (!m.ok) {
      REQ_ERR(res, 400, "invalid-mode", { requestId, mode: m.modeRaw });
      return true;
    }
    const pages = await getVisitsTopPages(m.effectiveMode, days);
    REQ_OK(res, { requestId, ok: true, mode: m.effectiveMode, days, pages: pages.slice(0, limit) });
    return true;
  }

  if (type === "visits_export") {
    if (!(await requireAdminAuth(req, res))) return true;

    const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "30", 10) || 30));
    const m = await resolveVisitsMode(url.searchParams.get("mode") || "auto");
    if (!m.ok) {
      REQ_ERR(res, 400, "invalid-mode", { requestId, mode: m.modeRaw });
      return true;
    }

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
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(buf);
    return true;
  }

  return false;
}
