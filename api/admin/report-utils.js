// /api/admin/report-utils.js
// --- Reporting / filtering helpers ---
export function parseDateISO(s) {
  if (!s) return NaN;
  const d = Date.parse(s);
  return isNaN(d) ? NaN : d;
}
export function parseYMD(s) {
  if (!s) return NaN;
  const d = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return isNaN(d) ? NaN : d;
}
export function sortByDateAsc(arr, key = "date") {
  return (arr || []).slice().sort((a, b) => {
    const ta = parseDateISO(a?.[key]);
    const tb = parseDateISO(b?.[key]);
    return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
  });
}

// Base id helper: everything before the first colon
export const baseKey = (s) => String(s || "").toLowerCase().split(":")[0];

// Legacy normalizer kept
export const normalizeKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/:(adult|child|youth)$/i, "");

// ---- Report frequency normalizer (shared) ----
// NOTE: report-scheduler.js uses a richer normalizer; this is the legacy one
const VALID_FREQS = ["daily", "weekly", "biweekly", "monthly", "none"];
export function normalizeReportFrequency(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "monthly";
  if (VALID_FREQS.includes(v)) return v;
  return "monthly";
}

export function filterRowsByWindow(rows, { startMs, endMs }) {
  if (!rows?.length) return rows || [];
  return rows.filter((r) => {
    const t = parseDateISO(r.date);
    if (isNaN(t)) return false;
    if (startMs && t < startMs) return false;
    if (endMs && t >= endMs) return false;
    return true;
  });
}

// Apply category / item filters (used by /orders, /orders_csv, and send_item_report)
export function applyItemFilters(rows, { category, item_id, item }) {
  let out = rows || [];

  if (category) {
    const cat = String(category).toLowerCase();
    out = out.filter((r) => String(r.category || "").toLowerCase() === cat);
  }

  if (item_id) {
    const wantRaw = String(item_id).toLowerCase();
    const wantBase = baseKey(wantRaw);
    const wantNorm = normalizeKey(wantRaw);

    out = out.filter((r) => {
      const raw = String(r._itemId || r.item_id || "").toLowerCase();
      const rawNorm = normalizeKey(raw);
      const keyBase = baseKey(r._itemId || r.item_id || "");
      const rowBase = r._itemBase || keyBase;

      return (
        raw === wantRaw ||
        rawNorm === wantNorm ||
        keyBase === wantBase ||
        rowBase === wantBase ||
        String(r._itemKey || "").toLowerCase() === wantNorm
      );
    });
  } else if (item) {
    const want = String(item).toLowerCase();
    out = out.filter((r) => String(r.item || "").toLowerCase().includes(want));
  }

  return out;
}

// Mail visibility helpers moved to ./mail-utils.js
// --- Coverage text helper for chair reports ---
export function formatCoverageRange({ startMs, endMs, rows }) {
  const fmt = (ms) =>
    new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  let start = typeof startMs === "number" && !isNaN(startMs) ? startMs : null;
  let end = typeof endMs === "number" && !isNaN(endMs) ? endMs - 1 : null;

  if ((start == null || end == null) && Array.isArray(rows) && rows.length) {
    const ts = rows.map((r) => parseDateISO(r.date)).filter((t) => !isNaN(t));
    if (ts.length) {
      const min = Math.min(...ts);
      const max = Math.max(...ts);
      if (start == null) start = min;
      if (end == null) end = max;
    }
  }

  if (start == null && end == null) return "";

  const startLabel = start != null ? fmt(start) : "beginning of recorded orders";
  const endLabel = end != null ? fmt(end) : "now";
  return `This report covers orders from ${startLabel} through ${endLabel}.`;
}
