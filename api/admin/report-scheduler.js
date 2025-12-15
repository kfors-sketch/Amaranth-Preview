// /api/admin/report-scheduler.js
import { kv } from "@vercel/kv";

// Small KV helpers (duplicated here to avoid importing from router.js)
async function kvGetSafe(key, fallback = null) {
  try {
    const v = await kv.get(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
async function kvHgetallSafe(key) {
  try {
    return (await kv.hgetall(key)) || {};
  } catch {
    return {};
  }
}
async function kvSetSafe(key, val) {
  try {
    await kv.set(key, val);
    return true;
  } catch {
    return false;
  }
}

// ---- Frequency helpers ----
// Internal normalized values:
//   "daily", "weekly", "twice-per-month", "monthly", "none"
const VALID_FREQS = ["daily", "weekly", "twice-per-month", "monthly", "none"];

function normalizeFrequency(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "monthly"; // default if nothing set

  // Map various UI / legacy labels to our internal set
  if (v === "biweekly") return "twice-per-month"; // backward compatibility
  if (v === "twice" || v === "twice per month" || v === "2x")
    return "twice-per-month";
  if (v === "do not auto send" || v === "do-not-auto-send") return "none";

  if (VALID_FREQS.includes(v)) return v;
  return "monthly"; // fallback
}

// Backwards-compatible alias used by older code (debug.js, router, etc.)
function normalizeReportFrequency(raw) {
  return normalizeFrequency(raw);
}

// Basic UTC date helpers (we do everything in UTC to avoid TZ gaps)
function startOfUTCDay(d) {
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0,
    0,
    0,
    0
  );
}

function addDays(ms, days) {
  return ms + days * 24 * 60 * 60 * 1000;
}

function startOfUTCMonth(year, monthIndex) {
  return Date.UTC(year, monthIndex, 1, 0, 0, 0, 0);
}

function startOfCurrentMonthUTC(now) {
  return startOfUTCMonth(now.getUTCFullYear(), now.getUTCMonth());
}

function startOfNextMonthUTC(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (m === 11) {
    return startOfUTCMonth(y + 1, 0);
  }
  return startOfUTCMonth(y, m + 1);
}

function startOfPreviousMonthUTC(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (m === 0) {
    return startOfUTCMonth(y - 1, 11);
  }
  return startOfUTCMonth(y, m - 1);
}

// ISO-week (Mon–Sun) helpers
function startOfISOWeekUTC(date) {
  const d = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    )
  );
  const day = d.getUTCDay() || 7;
  if (day !== 1) {
    d.setUTCDate(d.getUTCDate() - (day - 1));
  }
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0,
    0,
    0,
    0
  );
}

function isoWeekIdUTC(date) {
  const d = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    )
  );

  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);

  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// YYYY-MM-DD in UTC for stable “once per day” checks
function ymdUTCFromIso(iso) {
  const t = Date.parse(String(iso || "").trim());
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
}
function ymdUTCFromDate(d) {
  return d.toISOString().slice(0, 10);
}

// LOGGING ONLY
function computePeriodId(freq, now, windowStartMs, windowEndMs) {
  const f = normalizeFrequency(freq);
  if (!windowStartMs || !windowEndMs) return "";

  const start = new Date(windowStartMs);

  const ymd = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  if (f === "daily") return ymd(start);
  if (f === "weekly") return isoWeekIdUTC(start);

  if (f === "twice-per-month") {
    const ym = `${start.getUTCFullYear()}-${String(
      start.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const half = start.getUTCDate() <= 15 ? "1" : "2";
    return `${ym}-${half}`;
  }

  if (f === "monthly") {
    const y = start.getUTCFullYear();
    const m = String(start.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  return "";
}

// ---- Per-frequency window selectors ----
// NOTE: daily uses last_sent_at calendar day, NOT purely last_window_end_ms,
// so we don’t “Not due yet” because of a weird future/duplicate window end.
function computeDailyWindow(now, lastWindowEndMs, lastSentIso) {
  const todayStart = startOfUTCDay(now);
  const yesterdayStart = addDays(todayStart, -1);

  // If already sent today (UTC), do not send again.
  const lastSentDay = ymdUTCFromIso(lastSentIso);
  const todayDay = ymdUTCFromDate(now);
  if (lastSentDay && lastSentDay === todayDay) {
    return { skip: true, reason: "Not due yet" };
  }

  // Base window is yesterday -> todayStart.
  // If we have a stored lastWindowEndMs, continue from there.
  let startMs =
    lastWindowEndMs != null ? lastWindowEndMs : yesterdayStart;

  // Guard: if lastWindowEndMs is in the future or >= todayStart, clamp back
  // to yesterdayStart so we still deliver the expected “yesterday” window.
  if (startMs >= todayStart) startMs = yesterdayStart;

  const endMs = todayStart;

  if (endMs <= startMs) return { skip: true, reason: "Not due yet" };

  return { skip: false, startMs, endMs, label: "Daily (yesterday)" };
}

function computeWeeklyWindow(now, lastWindowEndMs) {
  const thisWeekStart = startOfISOWeekUTC(now);
  const prevWeekStart = addDays(thisWeekStart, -7);

  const startMs = lastWindowEndMs != null ? lastWindowEndMs : prevWeekStart;
  const endMs = thisWeekStart;

  if (endMs <= startMs) return { skip: true, reason: "Not due yet" };

  return {
    skip: false,
    startMs,
    endMs,
    label: "Weekly (previous ISO week)",
  };
}

function computeTwicePerMonthWindow(now, lastWindowEndMs) {
  const nowMs = now.getTime();
  const monthStart = startOfCurrentMonthUTC(now);
  const midPoint = addDays(monthStart, 15);
  const nextMonthStart = startOfNextMonthUTC(now);

  if (lastWindowEndMs == null) {
    if (nowMs < midPoint) return { skip: true, reason: "Not due yet" };
    return {
      skip: false,
      startMs: monthStart,
      endMs: midPoint,
      label: "Twice-per-month (1st–15th)",
    };
  }

  const lastEnd = lastWindowEndMs;

  if (lastEnd < midPoint) {
    if (nowMs < midPoint) return { skip: true, reason: "Not due yet" };
    const startMs = lastEnd;
    const endMs = midPoint;
    if (endMs <= startMs) return { skip: true, reason: "Not due yet" };
    return {
      skip: false,
      startMs,
      endMs,
      label: "Twice-per-month (1st–15th, catch-up)",
    };
  }

  if (lastEnd < nextMonthStart) {
    if (nowMs < nextMonthStart) return { skip: true, reason: "Not due yet" };
    const startMs = lastEnd;
    const endMs = nextMonthStart;
    if (endMs <= startMs) return { skip: true, reason: "Not due yet" };
    return {
      skip: false,
      startMs,
      endMs,
      label: "Twice-per-month (16th–end)",
    };
  }

  return { skip: true, reason: "Not due yet" };
}

function computeMonthlyWindow(now, lastWindowEndMs) {
  const thisMonthStart = startOfCurrentMonthUTC(now);
  const prevMonthStart = startOfPreviousMonthUTC(now);

  const nowMs = now.getTime();
  if (nowMs < thisMonthStart) return { skip: true, reason: "Not due yet" };

  const startMs = lastWindowEndMs != null ? lastWindowEndMs : prevMonthStart;
  const endMs = thisMonthStart;

  if (endMs <= startMs) return { skip: true, reason: "Not due yet" };

  return {
    skip: false,
    startMs,
    endMs,
    label: "Monthly (previous calendar month)",
  };
}

// ---- Main scheduler ----
export async function runScheduledChairReports({
  now = new Date(),
  sendItemReportEmailInternal,
}) {
  const nowMs = now.getTime();

  const banquets = (await kvGetSafe("banquets", [])) || [];
  const addons = (await kvGetSafe("addons", [])) || [];
  const products = (await kvGetSafe("products", [])) || [];

  const queue = [];
  const seenIds = new Set();

  // Archived / inactive should not even show up in queue (no skipped log spam).
  const isEntryEligible = (entry) => {
    if (!entry || typeof entry !== "object") return false;

    // Common patterns we’ve used across pages:
    if (entry.active === false) return false;
    if (entry.archived === true) return false;
    if (entry.isArchived === true) return false;

    // If you use publishStart/publishEnd for visibility, that is handled later,
    // but “archived” should be treated as hard-excluded.
    return true;
  };

  const pushItem = (kind, entry) => {
    if (!isEntryEligible(entry)) return;

    const id = String(entry?.id || "").trim();
    if (!id || seenIds.has(id)) return;

    seenIds.add(id);
    queue.push({
      kind,
      id,
      label: entry?.name || id,
      fromList: entry,
    });
  };

  for (const b of banquets) pushItem("banquet", b);
  for (const a of addons) pushItem("addon", a);
  for (const p of products) pushItem("catalog", p);

  let sent = 0;
  let errors = 0;
  let skipped = 0;
  const itemsLog = [];

  for (const item of queue) {
    const id = item.id;
    const cfg = await kvHgetallSafe(`itemcfg:${id}`);

    const publishStartMs = cfg?.publishStart
      ? Date.parse(cfg.publishStart)
      : NaN;
    const publishEndMs = cfg?.publishEnd
      ? Date.parse(cfg.publishEnd)
      : NaN;

    const label = cfg?.name || item.label || id;
    const kind = String(cfg?.kind || "").toLowerCase() || item.kind;

    const freq = normalizeFrequency(
      cfg?.reportFrequency ??
        cfg?.report_frequency ??
        item.fromList?.reportFrequency ??
        item.fromList?.report_frequency
    );

    let skip = false;
    let skipReason = "";

    if (!isNaN(publishStartMs) && nowMs < publishStartMs) {
      skip = true;
      skipReason = "Not yet open (publishStart in future)";
    } else if (!isNaN(publishEndMs) && nowMs > publishEndMs) {
      skip = true;
      skipReason = "Closed (publishEnd in past)";
    } else if (freq === "none") {
      skip = true;
      skipReason = "Frequency set to 'none'";
    }

    const lastWindowEndKey = `itemcfg:${id}:last_window_end_ms`;
    const lastWindowEndRaw = await kvGetSafe(lastWindowEndKey, null);
    let lastWindowEndMs = null;
    if (lastWindowEndRaw != null && lastWindowEndRaw !== "") {
      const num = Number(lastWindowEndRaw);
      if (Number.isFinite(num) && num > 0) lastWindowEndMs = num;
    }

    const lastSentKey = `itemcfg:${id}:last_sent_at`;
    const lastSentIso = await kvGetSafe(lastSentKey, "");

    let startMs = null;
    let endMs = null;
    let windowLabel = "";
    let periodId = "";

    if (!skip) {
      let result;
      switch (freq) {
        case "daily":
          result = computeDailyWindow(now, lastWindowEndMs, lastSentIso);
          break;
        case "weekly":
          result = computeWeeklyWindow(now, lastWindowEndMs);
          break;
        case "twice-per-month":
          result = computeTwicePerMonthWindow(now, lastWindowEndMs);
          break;
        case "monthly":
        default:
          result = computeMonthlyWindow(now, lastWindowEndMs);
          break;
      }

      if (result.skip) {
        skip = true;
        skipReason = result.reason || "Not due yet";
      } else {
        startMs = result.startMs;
        endMs = result.endMs;
        windowLabel = result.label || "";
        periodId = computePeriodId(freq, now, startMs, endMs);
      }
    }

    if (skip) {
      skipped += 1;
      itemsLog.push({
        id,
        label,
        kind,
        freq,
        periodId: periodId || "",
        ok: false,
        skipped: true,
        skipReason,
        count: 0,
        to: [],
        bcc: [],
        error: "",
        windowStartUTC: null,
        windowEndUTC: null,
      });
      continue;
    }

    const result = await sendItemReportEmailInternal({
      kind,
      id,
      label,
      scope: "window",
      startMs,
      endMs,
      windowLabel,
    });

    if (result.ok) {
      sent += 1;
      await kvSetSafe(lastWindowEndKey, String(endMs));
      await kvSetSafe(lastSentKey, now.toISOString());
    } else {
      errors += 1;
    }

    itemsLog.push({
      id,
      label,
      kind,
      freq,
      periodId: periodId || "",
      ok: !!result.ok,
      skipped: false,
      skipReason: "",
      count: result.count ?? 0,
      to: Array.isArray(result.to) ? result.to : [],
      bcc: Array.isArray(result.bcc) ? result.bcc : [],
      error: !result.ok ? result.error || result.message || "" : "",
      windowStartUTC: new Date(startMs).toISOString(),
      windowEndUTC: new Date(endMs).toISOString(),
    });
  }

  return { sent, skipped, errors, itemsLog };
}

// ---- REQUIRED BY debug.js (and any other imports) ----
export {
  normalizeFrequency,
  normalizeReportFrequency,
  computeDailyWindow,
  computeWeeklyWindow,
  computeTwicePerMonthWindow,
  computeMonthlyWindow,
};