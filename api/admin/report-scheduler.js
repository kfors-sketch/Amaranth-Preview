// /api/admin/report-scheduler.js
import { kv } from "@vercel/kv";

// FORCE RERUN FLAG (allows multiple test runs per day)
const FORCE_RERUN = process.env.REPORTS_FORCE_RERUN === "0";
/**
 * Goals of this edit:
 * 1) Align frequency naming with the rest of the codebase:
 *    internal normalized values: "daily", "weekly", "biweekly", "monthly", "none"
 *    (while still accepting legacy "twice-per-month" etc.)
 * 2) Keep your existing “twice per month” window behavior, but normalize it to "biweekly"
 *    so core.js / admin UIs / older configs don’t drift.
 * 3) Harden logging + error isolation so one item failure never stops the loop.
 */

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
//   "daily", "weekly", "biweekly", "monthly", "none"
const VALID_FREQS = ["daily", "weekly", "biweekly", "monthly", "none"];

function normalizeFrequency(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "monthly"; // default if nothing set

  // Map various UI / legacy labels to our internal set
  // Legacy variants for “biweekly / twice per month”
  if (v === "twice-per-month") return "biweekly";
  if (v === "twice per month") return "biweekly";
  if (v === "twice") return "biweekly";
  if (v === "2x") return "biweekly";
  if (v === "bi-weekly") return "biweekly";
  if (v === "bi weekly") return "biweekly";

  // Legacy “do not auto send”
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
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
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
  if (m === 11) return startOfUTCMonth(y + 1, 0);
  return startOfUTCMonth(y, m + 1);
}

function startOfPreviousMonthUTC(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (m === 0) return startOfUTCMonth(y - 1, 11);
  return startOfUTCMonth(y, m - 1);
}

// ISO-week (Mon–Sun) helpers
function startOfISOWeekUTC(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function isoWeekIdUTC(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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

  // We keep the original “twice per month” split, but call it biweekly.
  if (f === "biweekly") {
    const ym = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
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
  if (!FORCE_RERUN && lastSentDay && lastSentDay === todayDay) {
    return { skip: true, reason: "Not due yet" };
  }

  // Base window is yesterday -> todayStart.
  // If we have a stored lastWindowEndMs, continue from there.
  let startMs = lastWindowEndMs != null ? lastWindowEndMs : yesterdayStart;

  // Guard: if lastWindowEndMs is in the future or >= todayStart, clamp back.
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

/**
 * Biweekly (your existing behavior):
 * - Window 1: 1st -> 15th (exclusive midpoint at day 16 00:00Z, i.e. start + 15 days)
 * - Window 2: 15th -> next month start
 *
 * This is intentionally calendar-based (not “every 14 days”), matching your prior file.
 */
function computeBiweeklyWindow(now, lastWindowEndMs) {
  const nowMs = now.getTime();
  const monthStart = startOfCurrentMonthUTC(now);
  const midPoint = addDays(monthStart, 15); // 1st 00:00Z + 15 days => 16th 00:00Z
  const nextMonthStart = startOfNextMonthUTC(now);

  // First time ever: only send after we’ve reached the midpoint (so we can deliver 1st–15th).
  if (lastWindowEndMs == null) {
    if (nowMs < midPoint) return { skip: true, reason: "Not due yet" };
    return {
      skip: false,
      startMs: monthStart,
      endMs: midPoint,
      label: "Biweekly (1st–15th)",
    };
  }

  const lastEnd = lastWindowEndMs;

  // Catch-up to midpoint
  if (lastEnd < midPoint) {
    if (nowMs < midPoint) return { skip: true, reason: "Not due yet" };
    const startMs = lastEnd;
    const endMs = midPoint;
    if (endMs <= startMs) return { skip: true, reason: "Not due yet" };
    return {
      skip: false,
      startMs,
      endMs,
      label: "Biweekly (1st–15th, catch-up)",
    };
  }

  // Second half: only send after month ends (so we can deliver 16th–end)
  if (lastEnd < nextMonthStart) {
    if (nowMs < nextMonthStart) return { skip: true, reason: "Not due yet" };
    const startMs = lastEnd;
    const endMs = nextMonthStart;
    if (endMs <= startMs) return { skip: true, reason: "Not due yet" };
    return {
      skip: false,
      startMs,
      endMs,
      label: "Biweekly (16th–end)",
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
export async function runScheduledChairReports({ now = new Date(), sendItemReportEmailInternal }) {
  if (typeof sendItemReportEmailInternal !== "function") {
    throw new Error("runScheduledChairReports: sendItemReportEmailInternal is required");
  }

  const nowMs = now.getTime();

  // Load lists (KV may store null)
  const banquets = (await kvGetSafe("banquets", [])) || [];
  const addons = (await kvGetSafe("addons", [])) || [];
  const products = (await kvGetSafe("products", [])) || [];

  const queue = [];
  const seenIds = new Set();

  // Archived / inactive should not even show up in queue (no skipped log spam).
  const isEntryEligible = (entry) => {
    if (!entry || typeof entry !== "object") return false;

    // Common patterns across pages:
    if (entry.active === false) return false;
    if (entry.archived === true) return false;
    if (entry.isArchived === true) return false;

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

    // Default log skeleton (filled as we go)
    const baseLog = {
      id,
      label: item.label || id,
      kind: item.kind,
      freq: "",
      periodId: "",
      ok: false,
      skipped: false,
      skipReason: "",
      count: 0,
      to: [],
      bcc: [],
      error: "",
      windowStartUTC: null,
      windowEndUTC: null,
      windowLabel: "",
    };

    try {
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

      baseLog.label = label;
      baseLog.kind = kind;
      baseLog.freq = freq;

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

      // If forcing rerun, ignore prior send markers/windows so items are considered due.
      let _lastWindowEndMs = lastWindowEndMs;
      let _lastSentIso = lastSentIso;
      if (FORCE_RERUN) {
        _lastWindowEndMs = null;
        _lastSentIso = "";
      }


      let startMs = null;
      let endMs = null;
      let windowLabel = "";
      let periodId = "";

      if (!skip) {
        let result;
        switch (freq) {
          case "daily":
            result = computeDailyWindow(now, _lastWindowEndMs, _lastSentIso);
            break;
          case "weekly":
            result = computeWeeklyWindow(now, _lastWindowEndMs);
            break;
          case "biweekly":
            result = computeBiweeklyWindow(now, _lastWindowEndMs);
            break;
          case "monthly":
          default:
            result = computeMonthlyWindow(now, _lastWindowEndMs);
            break;
        }

        if (result.skip) {
          if (FORCE_RERUN) {
            // For testing: force a month-to-date window so we can re-send reports
            // multiple times per day regardless of frequency cadence.
            startMs = startOfCurrentMonthUTC(now);
            endMs = nowMs;
            windowLabel = "FORCE RERUN (month-to-date)";
            periodId = computePeriodId("daily", now, startMs, endMs);
            skip = false;
            skipReason = "";
          } else {
            skip = true;
            skipReason = result.reason || "Not due yet";
          }
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
          ...baseLog,
          periodId: periodId || "",
          ok: false,
          skipped: true,
          skipReason,
          windowStartUTC: null,
          windowEndUTC: null,
          windowLabel: windowLabel || "",
        });
        continue;
      }

      // Call sender (protect loop: any throw becomes an error entry, but loop continues)
      const result = await sendItemReportEmailInternal({
        kind,
        id,
        label,
        scope: "window",
        startMs,
        endMs,
        windowLabel,
      });

      if (result?.ok) {
        sent += 1;
        if (!FORCE_RERUN) {
          // Persist window end + last sent time
          await kvSetSafe(lastWindowEndKey, String(endMs));
          await kvSetSafe(lastSentKey, now.toISOString());
        }
      } else {
        errors += 1;
      }

      itemsLog.push({
        ...baseLog,
        periodId: periodId || "",
        ok: !!result?.ok,
        skipped: false,
        skipReason: "",
        count: result?.count ?? 0,
        to: Array.isArray(result?.to) ? result.to : [],
        bcc: Array.isArray(result?.bcc) ? result.bcc : [],
        error: !result?.ok ? result?.error || result?.message || "send-failed" : "",
        windowStartUTC: new Date(startMs).toISOString(),
        windowEndUTC: new Date(endMs).toISOString(),
        windowLabel: windowLabel || "",
      });
    } catch (e) {
      errors += 1;
      itemsLog.push({
        ...baseLog,
        ok: false,
        skipped: false,
        error: String(e?.message || e || "unknown-error"),
      });
      // continue to next item
    }
  }

  return { sent, skipped, errors, itemsLog };
}

// ---- REQUIRED BY debug.js (and any other imports) ----
export {
  normalizeFrequency,
  normalizeReportFrequency,
  computeDailyWindow,
  computeWeeklyWindow,
  computeBiweeklyWindow,
  computeMonthlyWindow,
};