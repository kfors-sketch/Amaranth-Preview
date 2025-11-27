// /api/admin/report-scheduler.js
import { kv } from "@vercel/kv";

// Small KV helpers (duplicated here to avoid importing from router.js)
async function kvGetSafe(key, fallback = null) {
  try { return await kv.get(key); } catch { return fallback; }
}
async function kvHgetallSafe(key) {
  try { return (await kv.hgetall(key)) || {}; } catch { return {}; }
}
async function kvSetSafe(key, val) {
  try { await kv.set(key, val); return true; } catch { return false; }
}

// ---- Frequency helpers ----
const VALID_FREQS = ["daily", "weekly", "biweekly", "monthly", "none"];

function normalizeFrequency(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "monthly";           // default if nothing set
  if (VALID_FREQS.includes(v)) return v;
  return "monthly";                   // fallback
}

function formatYMDUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatYMUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isoWeekIdUTC(date) {
  // ISO week-numbering year/week
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

function computePeriodId(freq, now) {
  const f = normalizeFrequency(freq);
  if (f === "none") return ""; // no period
  if (f === "daily") return formatYMDUTC(now);
  if (f === "weekly") return isoWeekIdUTC(now);
  if (f === "biweekly") {
    const ym = formatYMUTC(now);
    const half = now.getUTCDate() <= 15 ? "1" : "2"; // first or second half of month
    return `${ym}-${half}`;
  }
  // monthly
  return formatYMUTC(now);
}

// ---- Main scheduler ----
//
// This helper decides WHICH items get a report this run, based on:
//   - publishStart / publishEnd window
//   - per-item reportFrequency (daily/weekly/biweekly/monthly/none)
//   - per-item last sent period key
//
// It does NOT send log emails. It just calls sendItemReportEmailInternal
// and returns a log of what happened so router.js can email/report.
//
export async function runScheduledChairReports({ now = new Date(), sendItemReportEmailInternal }) {
  const nowMs = now.getTime();

  const banquets = (await kvGetSafe("banquets", [])) || [];
  const addons   = (await kvGetSafe("addons",  [])) || [];
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
      fromList: entry
    });
  };

  for (const b of banquets) pushItem("banquet", b);
  for (const a of addons)   pushItem("addon", a);
  for (const p of products) pushItem("catalog", p);

  let sent = 0;
  let errors = 0;
  let skipped = 0;
  const itemsLog = [];

  for (const item of queue) {
    const id = item.id;
    const cfg = await kvHgetallSafe(`itemcfg:${id}`);

    const publishStartMs = cfg?.publishStart ? Date.parse(cfg.publishStart) : NaN;
    const publishEndMs   = cfg?.publishEnd   ? Date.parse(cfg.publishEnd)   : NaN;

    const label = cfg?.name || item.label || id;
    const kind  = String(cfg?.kind || "").toLowerCase() || item.kind;

    const freq = normalizeFrequency(
      cfg?.reportFrequency ??
      cfg?.report_frequency ??
      item.fromList?.reportFrequency ??
      item.fromList?.report_frequency
    );

    const periodId = computePeriodId(freq, now);

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
    } else if (!periodId) {
      skip = true;
      skipReason = "Unsupported frequency";
    }

    const lastKey = `itemcfg:${id}:last_period:${freq}`;

    if (!skip) {
      const lastPeriod = await kvGetSafe(lastKey, "");
      if (lastPeriod === periodId) {
        skip = true;
        skipReason = "Already sent for this period";
      }
    }

    if (skip) {
      skipped += 1;
      itemsLog.push({
        id,
        label,
        kind,
        freq,
        periodId,
        ok: false,
        skipped: true,
        skipReason,
        count: 0,
        to: [],
        bcc: [],
        error: ""
      });
      continue;
    }

    // Send report for this item (current-month scope, same as before)
    const result = await sendItemReportEmailInternal({
      kind,
      id,
      label,
      scope: "current-month"
    });

    if (result.ok) {
      sent += 1;
      await kvSetSafe(lastKey, periodId);
    } else {
      errors += 1;
    }

    itemsLog.push({
      id,
      label,
      kind,
      freq,
      periodId,
      ok: !!result.ok,
      skipped: false,
      skipReason: "",
      count: result.count ?? 0,
      to: Array.isArray(result.to) ? result.to : [],
      bcc: Array.isArray(result.bcc) ? result.bcc : [],
      error: !result.ok ? (result.error || result.message || "") : ""
    });
  }

  return { sent, skipped, errors, itemsLog };
}
