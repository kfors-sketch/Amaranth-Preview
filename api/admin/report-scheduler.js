// /api/admin/report-scheduler.js
import { kv } from "@vercel/kv";

// Small KV helpers (duplicated here to avoid importing from router.js)
async function kvGetSafe(key, fallback = null) {
  try {
    return await kv.get(key);
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

// Basic UTC date helpers (we do everything in UTC to avoid TZ gaps)
function startOfUTCDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function addDays(ms, days) {
  return ms + days * 24 * 60 * 60 * 1000;
}

function startOfUTCMonth(year, monthIndex) {
  // monthIndex: 0–11 (same as JS Date)
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
    // Previous year, December
    return startOfUTCMonth(y - 1, 11);
  }
  return startOfUTCMonth(y, m - 1);
}

// ISO-week (Mon–Sun) helpers: we treat weeks as Monday 00:00 → next Monday 00:00
function startOfISOWeekUTC(date) {
  // Create a date at UTC midnight
  const d = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const day = d.getUTCDay() || 7; // 1 = Monday, 7 = Sunday
  if (day !== 1) {
    d.setUTCDate(d.getUTCDate() - (day - 1)); // move back to Monday
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function isoWeekIdUTC(date) {
  // ISO week-numbering year/week (for logging only)
  const d = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  // Thursday in current week decides the year
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);

  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// This is now only for LOGGING (not for scheduling).
function computePeriodId(freq, now, windowStartMs, windowEndMs) {
  const f = normalizeFrequency(freq);
  if (!windowStartMs || !windowEndMs) return "";

  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);

  const ymd = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  if (f === "daily") {
    // Daily: show the covered day (usually "yesterday")
    return ymd(start);
  }
  if (f === "weekly") {
    return isoWeekIdUTC(start);
  }
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

// ---- Per-frequency window selection ----
//
// We assume each item has a "pointer" for the last covered time:
//
//   itemcfg:<id>:last_window_end_ms
//
// On each run, we compute the *next* window as:
//
//   startMs = lastWindowEndMs ?? naturalPeriodStart
//   endMs   = naturalPeriodEnd
//
// If endMs <= startMs => "Not due yet" (already covered).
//
// This guarantees NO FUTURE GAPS from this scheduler forward.
//
// NOTE: all times are UTC ms since epoch.

function computeDailyWindow(now, lastWindowEndMs) {
  const todayStart = startOfUTCDay(now);
  const yesterdayStart = addDays(todayStart, -1);

  const startMs = lastWindowEndMs != null ? lastWindowEndMs : yesterdayStart;
  const endMs = todayStart;

  if (endMs <= startMs) {
    return { skip: true, reason: "Not due yet" };
  }

  return {
    skip: false,
    startMs,
    endMs,
    label: "Daily (yesterday)",
  };
}

function computeWeeklyWindow(now, lastWindowEndMs) {
  // Previous ISO week: Monday 00:00 → this Monday 00:00
  const thisWeekStart = startOfISOWeekUTC(now);
  const prevWeekStart = addDays(thisWeekStart, -7);

  const startMs = lastWindowEndMs != null ? lastWindowEndMs : prevWeekStart;
  const endMs = thisWeekStart;

  if (endMs <= startMs) {
    return { skip: true, reason: "Not due yet" };
  }

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
  const midPoint = addDays(monthStart, 15); // 1st–15th → ends at 16th 00:00
  const nextMonthStart = startOfNextMonthUTC(now);

  // If we've never sent for this item on this schedule:
  if (lastWindowEndMs == null) {
    if (nowMs < midPoint) {
      // First half not finished yet
      return { skip: true, reason: "Not due yet" };
    }
    // First half is complete, but no previous pointer:
    // Cover 1st–15th
    const startMs = monthStart;
    const endMs = midPoint;
    return {
      skip: false,
      startMs,
      endMs,
      label: "Twice-per-month (1st–15th)",
    };
  }

  // We HAVE a pointer, so decide which half we’re in.
  const lastEnd = lastWindowEndMs;

  // If we haven't yet covered the first half (pointer before midPoint)
  if (lastEnd < midPoint) {
    if (nowMs < midPoint) {
      // First half not done yet
      return { skip: true, reason: "Not due yet" };
    }
    // First half has completed; cover from lastEnd to midPoint
    const startMs = lastEnd;
    const endMs = midPoint;
    if (endMs <= startMs) {
      return { skip: true, reason: "Not due yet" };
    }
    return {
      skip: false,
      startMs,
      endMs,
      label: "Twice-per-month (1st–15th, catch-up)",
    };
  }

  // We already covered at least through midPoint.
  // Next half is 16th → end of month (ends at nextMonthStart).
  if (lastEnd < nextMonthStart) {
    if (nowMs < nextMonthStart) {
      return { skip: true, reason: "Not due yet" };
    }
    const startMs = lastEnd;
    const endMs = nextMonthStart;
    if (endMs <= startMs) {
      return { skip: true, reason: "Not due yet" };
    }
    return {
      skip: false,
      startMs,
      endMs,
      label: "Twice-per-month (16th–end)",
    };
  }

  // Pointer is already at or beyond the end of last month’s second half
  // → we’re waiting for the next half-month boundary, which hasn't closed yet.
  return { skip: true, reason: "Not due yet" };
}

function computeMonthlyWindow(now, lastWindowEndMs) {
  // Option A: monthly = ENTIRE PREVIOUS CALENDAR MONTH
  const thisMonthStart = startOfCurrentMonthUTC(now);
  const prevMonthStart = startOfPreviousMonthUTC(now);

  // We don’t strictly require "today is the 1st" here; as soon as we're
  // in a new month, we can send the previous-month report once.
  const nowMs = now.getTime();
  if (nowMs < thisMonthStart) {
    // Still in previous month (shouldn't really happen for monthly cron),
    // but just in case: not due.
    return { skip: true, reason: "Not due yet" };
  }

  const startMs = lastWindowEndMs != null ? lastWindowEndMs : prevMonthStart;
  const endMs = thisMonthStart;

  if (endMs <= startMs) {
    return { skip: true, reason: "Not due yet" };
  }

  return {
    skip: false,
    startMs,
    endMs,
    label: "Monthly (previous calendar month)",
  };
}

// ---- Main scheduler ----
//
// This helper decides WHICH items get a report this run, based on:
//   - publishStart / publishEnd window
//   - per-item reportFrequency (daily/weekly/twice-per-month/monthly/none)
//   - per-item last_window_end_ms pointer
//
// It does NOT send log emails. It just calls sendItemReportEmailInternal
// and returns a log of what happened so router.js can email/report.
//
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

  const pushItem = (kind, entry) => {
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

    const publishStartMs = cfg?.publishStart ? Date.parse(cfg.publishStart) : NaN;
    const publishEndMs = cfg?.publishEnd ? Date.parse(cfg.publishEnd) : NaN;

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

    // Publish window checks first
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

    // Per-item contiguous window pointer (NO GAPS from this scheduler)
    const lastWindowEndKey = `itemcfg:${id}:last_window_end_ms`;
    const lastWindowEndRaw = await kvGetSafe(lastWindowEndKey, null);
    let lastWindowEndMs = null;
    if (lastWindowEndRaw != null && lastWindowEndRaw !== "") {
      const num = Number(lastWindowEndRaw);
      if (Number.isFinite(num) && num > 0) {
        lastWindowEndMs = num;
      }
    }

    let startMs = null;
    let endMs = null;
    let windowLabel = "";
    let periodId = "";

    if (!skip) {
      let result;
      switch (freq) {
        case "daily":
          result = computeDailyWindow(now, lastWindowEndMs);
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

    // ---- Send report for this item over the computed window ----
    //
    // We pass explicit startMs/endMs and a "window" scope. For this to be
    // fully effective, sendItemReportEmailInternal in core.js should honor
    // these fields instead of defaulting to "current-month".
    const result = await sendItemReportEmailInternal({
      kind,
      id,
      label,
      scope: "window", // NEW: indicates explicit time window
      startMs,
      endMs,
      windowLabel,
    });

    if (result.ok) {
      sent += 1;
      // Move the pointer forward — this guarantees no future gaps.
      await kvSetSafe(lastWindowEndKey, String(endMs));
      // Optional: keep legacy last_sent_at for any old logic/inspection
      const lastSentKey = `itemcfg:${id}:last_sent_at`;
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