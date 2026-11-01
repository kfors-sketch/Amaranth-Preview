import ExcelJS from "exceljs";
import { resend, RESEND_FROM, REPLY_TO, REPORTS_LOG_TO, getEffectiveSettings } from "./env.js";
import { sendWithRetry } from "./retry.js";
import { objectsToXlsxBuffer } from "./xlsx.js";
import { flattenOrderToRows } from "./orders-flatten.js";
import { loadAllOrdersWithRetry } from "./orders-load.js";
import { getChairEmailsForItemId } from "./chair-emails.js";
import {
  parseDateISO,
  parseYMD,
  baseKey,
  sortByDateAsc,
  recordMailLog,
  formatCoverageRange,
} from "./reporting.js";

// REPORT EMAIL STAGGERING (scheduled_at)
// Keeps reports spaced out for Yahoo recipients within one function invocation.
let _REPORT_STAGGER = {
  baseMs: 0,
  idx: 0,
  lastTouchedMs: 0,
};

function nextReportScheduledAtIso({ allow, hasYahoo, explicitIso }) {
  if (!allow || !hasYahoo) return "";
  if (explicitIso) return explicitIso;

  const now = Date.now();
  if (!_REPORT_STAGGER.baseMs || now - (_REPORT_STAGGER.lastTouchedMs || 0) > 5 * 60_000) {
    _REPORT_STAGGER.baseMs = now;
    _REPORT_STAGGER.idx = 0;
  }
  _REPORT_STAGGER.lastTouchedMs = now;

  const idx = _REPORT_STAGGER.idx++;
  if (idx <= 0) return "";

  const t = _REPORT_STAGGER.baseMs + idx * 60_000;
  if (t <= now + 30_000) return "";
  return new Date(t).toISOString();
}

function collectAttendeesFromOrders(
  orders,
  { includeAddress = false, categories = [], startMs, endMs } = {}
) {
  const cats = (categories || []).map((c) => String(c || "").toLowerCase()).filter(Boolean);

  const allRows = [];
  for (const o of orders || []) {
    const rows = flattenOrderToRows(o);
    for (const r of rows) {
      const t = parseDateISO(r.date);
      if (startMs && !isNaN(t) && t < startMs) continue;
      if (endMs && !isNaN(t) && t >= endMs) continue;

      if (cats.length) {
        const rc = String(r.category || "").toLowerCase();
        if (!cats.includes(rc)) continue;
      }

      const base = {
        date: r.date,
        attendee: r.attendee,
        attendee_title: r.attendee_title,
        attendee_phone: r.attendee_phone,
        attendee_email: r.attendee_email,
        court: r.court,
        court_number: r.court_number,
        item: r.item,
        item_id: r.item_id,
        qty: r.qty,
        notes: r.notes,
      };

      if (includeAddress) {
        allRows.push({
          ...base,
          attendee_addr1: r.attendee_addr1,
          attendee_addr2: r.attendee_addr2,
          attendee_city: r.attendee_city,
          attendee_state: r.attendee_state,
          attendee_postal: r.attendee_postal,
          attendee_country: r.attendee_country,
        });
      } else {
        allRows.push(base);
      }
    }
  }

  return allRows;
}

// ---------------------------------------------------------------------------
// Chair report sender (attachment-hardened + scheduled_at safety)
// ---------------------------------------------------------------------------

async function sendItemReportEmailInternal({
  kind,
  id,
  label,
  scope = "current-month",
  startDate,
  endDate,
  startMs: explicitStartMs,
  endMs: explicitEndMs,
  scheduledAt,
  scheduled_at,

  // ✅ ADD THIS
  mode,

  // test tools
  toOverride,
  subjectPrefix,
  previewOnly,
} = {}) {
  if (!resend) return { ok: false, error: "resend-not-configured" };
  if (!kind || !id) return { ok: false, error: "missing-kind-or-id" };

  if (!RESEND_FROM) throw new Error("RESEND_FROM missing");
  const from = RESEND_FROM;

  // we still accept it, but we won't pass scheduled_at when attachments are present
  let scheduledAtIso = (scheduled_at || scheduledAt || "").trim();
  if (scheduledAtIso) {
    const t = Date.parse(scheduledAtIso);
    if (isNaN(t)) {
      console.warn("[sendItemReportEmailInternal] invalid scheduled time:", scheduledAtIso);
      scheduledAtIso = "";
    } else {
      if (t <= Date.now() + 30 * 1000) scheduledAtIso = "";
      else scheduledAtIso = new Date(t).toISOString();
    }
  }

  const orders = await loadAllOrdersWithRetry();

  // ✅ Filter orders by report channel (test/live_test/live) when provided
  const normMode = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s === "live-test" || s === "livetest") return "live_test";
    if (s === "test" || s === "live_test" || s === "live") return s;
    return "";
  };

  const wantMode = normMode(mode);
  const ordersForMode = wantMode
    ? (orders || []).filter((o) => {
        const m = normMode(o?.mode || o?.orderMode || o?.order_channel || o?.channel);
        return m === wantMode;
      })
    : orders;


  let startMs =
    typeof explicitStartMs === "number" && !isNaN(explicitStartMs) ? explicitStartMs : undefined;
  let endMs = typeof explicitEndMs === "number" && !isNaN(explicitEndMs) ? explicitEndMs : undefined;

  if (scope === "current-month" && startMs == null && endMs == null) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    startMs = start.getTime();
    endMs = Date.now() + 1;
  }

  if (scope === "custom" && startMs == null && endMs == null) {
    if (startDate) {
      const dStart = parseYMD(startDate);
      if (!isNaN(dStart)) startMs = dStart;
    }
    if (endDate) {
      const dEnd = parseYMD(endDate);
      if (!isNaN(dEnd)) endMs = dEnd + 24 * 60 * 60 * 1000;
    }
  }

  const base = baseKey(id);
  const includeAddressForThisItem = base === "pre-reg" || base === "directory" || base === "proceedings";
  const isLoveGiftBase = /(^|[-_])(love|gift|lovegift|love-gift)s?($|[-_])/.test(base);
  const isCorsageBase = /(corsage|boutonniere)/.test(base);
  const isBanquetKind = String(kind || "").toLowerCase() === "banquet";
  const isPreRegBase = base === "pre-reg";
  const isDirectoryBase = base === "directory";
  const isProceedingsBase = base === "proceedings";

  const rosterAll = collectAttendeesFromOrders(ordersForMode, {
    includeAddress: includeAddressForThisItem,
    categories: [String(kind).toLowerCase()],
    startMs,
    endMs,
  });

  const wantBase = (s) => String(s || "").toLowerCase().split(":")[0];
  const filtered = rosterAll.filter(
    (r) =>
      wantBase(r.item_id) === wantBase(id) ||
      (!r.item_id &&
        label &&
        String(r.item || "").toLowerCase().includes(String(label).toLowerCase()))
  );

  let EMAIL_COLUMNS = ["#", "date", "attendee", "attendee_title", "attendee_phone", "item", "qty", "notes"];
  let EMAIL_HEADER_LABELS = {
    "#": "#",
    date: "Date",
    attendee: "Attendee",
    attendee_title: "Title",
    attendee_phone: "Phone",
    item: "Item",
    qty: "Qty",
    notes: "Notes",
  };

  if (includeAddressForThisItem) {
    EMAIL_COLUMNS = [
      "#",
      "date",
      "attendee",
      "attendee_title",
      "attendee_phone",
      "attendee_email",
      "attendee_addr1",
      "attendee_addr2",
      "attendee_city",
      "attendee_state",
      "attendee_postal",
      "attendee_country",
      "item",
      "qty",
      "notes",
    ];
    EMAIL_HEADER_LABELS = {
      "#": "#",
      date: "Date",
      attendee: "Attendee",
      attendee_title: "Title",
      attendee_phone: "Phone",
      attendee_email: "Email",
      attendee_addr1: "Address 1",
      attendee_addr2: "Address 2",
      attendee_city: "City",
      attendee_state: "State",
      attendee_postal: "Postal",
      attendee_country: "Country",
      item: "Item",
      qty: "Qty",
      notes: "Notes",
    };
  }
  if (isLoveGiftBase && !isCorsageBase) {
    EMAIL_COLUMNS = (EMAIL_COLUMNS || []).flatMap((c) =>
      c === "item" ? ["item_name", "item_price"] : [c]
    );
    const lbl = { ...EMAIL_HEADER_LABELS };
    delete lbl.item;
    lbl.item_name = "Item";
    lbl.item_price = "Price";
    EMAIL_HEADER_LABELS = lbl;
  }

  // Banquets: include Court and Court #
  if (isBanquetKind) {
    const cols = Array.isArray(EMAIL_COLUMNS) ? [...EMAIL_COLUMNS] : [];
    const insertAfterKey = "attendee_phone";
    const afterIdx = cols.indexOf(insertAfterKey);
    const want = ["court", "court_number"];
    // Insert in a stable spot near attendee info
    for (let i = want.length - 1; i >= 0; i--) {
      const key = want[i];
      if (cols.includes(key)) continue;
      if (afterIdx >= 0) cols.splice(afterIdx + 1, 0, key);
      else cols.push(key);
    }
    EMAIL_COLUMNS = cols;
    EMAIL_HEADER_LABELS = {
      ...EMAIL_HEADER_LABELS,
      court: "Court",
      court_number: "Court #",
    };
  }

  // Pre-Registration / Printed Directory / Proceedings: include Court and Court #
  // (These are attendee-based but are not "banquet" kind, so they need their own injection.)
  if (isPreRegBase || isDirectoryBase || isProceedingsBase) {
    const cols = Array.isArray(EMAIL_COLUMNS) ? [...EMAIL_COLUMNS] : [];
    const insertAfterKey = "attendee_phone";
    const afterIdx = cols.indexOf(insertAfterKey);
    const want = ["court", "court_number"];
    for (let i = want.length - 1; i >= 0; i--) {
      const key = want[i];
      if (cols.includes(key)) continue;
      if (afterIdx >= 0) cols.splice(afterIdx + 1, 0, key);
      else cols.push(key);
    }
    EMAIL_COLUMNS = cols;
    EMAIL_HEADER_LABELS = {
      ...EMAIL_HEADER_LABELS,
      court: "Court",
      court_number: "Court #",
    };
  }
  // Corsage/Boutonniere: Wear Style is included in the Item text, so we do NOT add a separate column.
  if (isBanquetKind) {
    EMAIL_COLUMNS = (EMAIL_COLUMNS || []).flatMap((c) => (c === "item" ? ["item", "meal_type"] : [c]));
    EMAIL_HEADER_LABELS = { ...EMAIL_HEADER_LABELS, meal_type: "Meal Type" };
  }

  if (isPreRegBase) {
    // Ensure Pre-Registration chair spreadsheets clearly indicate Voting vs Non-Voting
    const cols = Array.isArray(EMAIL_COLUMNS) ? [...EMAIL_COLUMNS] : [];
    if (!cols.includes("voting_status")) {
      const at = cols.indexOf("attendee_title");
      const insAt = at >= 0 ? at + 1 : 0;
      cols.splice(insAt, 0, "voting_status");
      EMAIL_COLUMNS = cols;
    }
    EMAIL_HEADER_LABELS = { ...EMAIL_HEADER_LABELS, voting_status: "Voting Status" };
  }


  const sorted = sortByDateAsc(filtered, "date");
  let counter = 1;

  const numbered = sorted.map((r) => {
    const hasAttendee = String(r.attendee || "").trim().length > 0;

    const splitItemAndPrice = (val) => {
      const s = String(val || "").trim();
      // Match a trailing price like "$25" or "$25.00" (optionally preceded by dash/colon)
      const m = s.match(/^(.*?)(?:\s*[-–—:]\s*)?\$\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*$/);
      if (!m) return { item_name: s, item_price: "" };
      const name = String(m[1] || "").replace(/[-–—:\s]+$/g, "").trim();
      return { item_name: name || s, item_price: m[2] || "" };
    };

    const ip = isLoveGiftBase ? splitItemAndPrice(r.item) : null;

    const splitMealType = (val) => {
      const s = String(val || "").trim();
      const m = s.match(/^(.*)\(([^)]+)\)\s*$/);
      if (!m) return { item: s, meal_type: "" };
      const baseName = String(m[1] || "").trim();
      const inside = String(m[2] || "").trim();
      let meal = "";
      if (/chicken/i.test(inside)) meal = "Chicken";
      else if (/beef/i.test(inside)) meal = "Beef";
      else meal = inside;
      return { item: baseName || s, meal_type: meal };
    };

    const bm = isBanquetKind ? splitMealType(r.item) : null;

    const deriveVotingStatus = (row) => {
      // No defaults: only return a value if it is explicitly present in stored text.
      const blob = [row?.attendee_title, row?.item, row?.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (/non\s*-?\s*voting/.test(blob) || /nonvoting/.test(blob)) return "Non-Voting";
      if (/\bvoting\b/.test(blob)) return "Voting";
      return "";
    };

    const baseRow = {
      "#": hasAttendee ? counter++ : "",
      date: r.date,
      attendee: r.attendee,
      attendee_title: r.attendee_title,
      attendee_phone: r.attendee_phone,
    };
    
	// ✅ Court fields (needed because we add these headers for banquets + certain addons)
      if ((EMAIL_COLUMNS || []).includes("court")) {
      baseRow.court = r.court || "";
    }
      if ((EMAIL_COLUMNS || []).includes("court_number")) {
      baseRow.court_number = r.court_number || "";
    }


    if (isPreRegBase) {
      baseRow.voting_status = deriveVotingStatus(r);
    }

    const itemFields = isLoveGiftBase
      ? { item_name: ip.item_name, item_price: ip.item_price }
      : isBanquetKind
        ? { item: bm.item, meal_type: bm.meal_type }
        : { item: r.item };

    if (includeAddressForThisItem) {
      return {
        ...baseRow,
        attendee_email: r.attendee_email,
        attendee_addr1: r.attendee_addr1,
        attendee_addr2: r.attendee_addr2,
        attendee_city: r.attendee_city,
        attendee_state: r.attendee_state,
        attendee_postal: r.attendee_postal,
        attendee_country: r.attendee_country,
        ...itemFields,
        qty: r.qty,
        notes: r.notes,
      };
    }

    return { ...baseRow, ...itemFields, qty: r.qty, notes: r.notes };
  });

    // ✅ XLSX ATTACHMENT (always attach for chair reports)
  // FIX: Always generate a valid workbook. If there are no rows, Excel will still contain the header row.
  let xlsxBuf = null;
  try {
    const xlsxRaw = await objectsToXlsxBuffer(
      EMAIL_COLUMNS,
      numbered, // may be []
      EMAIL_HEADER_LABELS,
      "Report",
      { spacerRows: true, autoFit: true }
    );
    xlsxBuf = Buffer.isBuffer(xlsxRaw) ? xlsxRaw : Buffer.from(xlsxRaw);
  } catch (e) {
    console.error("chair-report-xlsx-build-failed", { kind, id, label, scope }, e);
    xlsxBuf = null;
  }

  // SAFETY: ensure we always have a non-empty XLSX buffer (at minimum, headers)
  if (!xlsxBuf || xlsxBuf.length === 0) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Report");
    const headerRow = (EMAIL_COLUMNS || []).map((c) => (EMAIL_HEADER_LABELS && EMAIL_HEADER_LABELS[c]) || c);
    sheet.addRow(headerRow);
    xlsxBuf = Buffer.from(await workbook.xlsx.writeBuffer());
  }

const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const baseNameRaw = label || id || "report";
  const baseName = baseNameRaw.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  const filename = `Report_${id || "item"}_${scope || "current"}.xlsx`;

  const toListPref = await getChairEmailsForItemId(id);
  const { effective } = await getEffectiveSettings();

  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const envFallback = safeSplit(
      effective.REPORTS_BCC ||
      process.env.REPORTS_BCC ||
      ""
  );

  let toList = [];
  if (Array.isArray(toOverride) && toOverride.length) {
    toList = [...toOverride];
  } else if (toListPref.length && envFallback.length) {
    toList = [...toListPref, ...envFallback.filter((addr) => !toListPref.includes(addr))];
  } else if (toListPref.length) {
    toList = [...toListPref];
  } else {
    toList = [...envFallback];
  }

  const adminBccBase = safeSplit(
    effective.REPORTS_BCC || process.env.REPORTS_BCC || ""
  );
  const bccList = adminBccBase.filter((addr) => !toList.includes(addr));

  if (!toList.length && !bccList.length) return { ok: false, error: "no-recipient" };

  // ---------------------------------------------------------------------------
  // ✅ STAGGER REPORT EMAILS (single cron, no sleeps)
  //
  // Minimal change approach: if scheduling is enabled and a Yahoo recipient is
  // present, schedule *subsequent* report emails 1 minute apart. The first email
  // is immediate.
  //
  // Default: ON (to prevent burst delivery). Disable via: REPORTS_ALLOW_SCHEDULED_AT=0
  // ---------------------------------------------------------------------------
  const allowScheduled = String(process.env.REPORTS_ALLOW_SCHEDULED_AT || "1") === "1";
  const allRcpt = [...toList, ...bccList];
  const hasYahoo = allRcpt.some((e) => /@yahoo\.com$/i.test(String(e || "").trim()));

  if (!scheduledAtIso) {
    scheduledAtIso = nextReportScheduledAtIso({ allow: allowScheduled, hasYahoo, explicitIso: scheduledAtIso });
  }

  const prettyKind = kind === "other" ? "catalog" : kind;

  const scopeLabel =
    scope === "current-month"
      ? "current month (month-to-date)"
      : scope === "full"
        ? "full history (all orders for this item)"
        : scope === "custom"
          ? "custom date range"
          : String(scope || "");

  const coverageText = formatCoverageRange({ startMs, endMs, rows: sorted });

  const subject = `Report — ${prettyKind}: ${label || id}`;
  const emailSubject = `${(subjectPrefix || "").toString()}${subject}`;
  const tablePreview = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
      <p>Attached is the Excel report for <b>${prettyKind}</b> “${label || id}”.</p>
      <p>Rows: <b>${sorted.length}</b></p>
      <div style="font-size:12px;color:#555;margin:2px 0;">Scope: ${scopeLabel}</div>
      ${coverageText ? `<p style="font-size:12px;color:#555;margin:2px 0 0;">${coverageText}</p>` : ""}
      <div style="font-size:12px;color:#555;margin:6px 0 0;">Attachment: <b>${filename}</b></div>
    </div>`;

  const payload = {
    from: from,
    to: toList.length ? toList : bccList,
    bcc: toList.length && bccList.length ? bccList : undefined,
    subject,
    html: tablePreview,
    reply_to: REPLY_TO || undefined,
    attachments: [
      {
        filename,
        content: xlsxBuf,
        content_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };

  // ✅ SCHEDULE SAFETY:
// These chair reports include XLSX attachments.
// Although Resend supports scheduled delivery, scheduled sends combined with
// attachments can lead to inconsistent behavior with some providers/clients.
// So we ONLY schedule when there are NO attachments.
//
// To reduce burst delivery without scheduling, set:
//   REPORTS_THROTTLE_MS=15000   (example: 15s between report emails)
if (scheduledAtIso && allowScheduled && (!payload.attachments || payload.attachments.length === 0)) {
  // Resend SDK expects `scheduledAt` (camelCase). We also set `scheduled_at`
  // for backward-compat / log readability, but `scheduledAt` is the one that matters.
  payload.scheduledAt = scheduledAtIso;
  payload.scheduled_at = scheduledAtIso;
}

  if (previewOnly) {
    return {
      ok: true,
      preview: true,
      kind,
      id,
      scope,
      to: toList,
      bcc: bccList,
      subject: emailSubject,
      filename,
      rowCount: Array.isArray(numbered) ? numbered.length : 0,
    };
  }

  const retry = await sendWithRetry(() => resend.emails.send(payload), `item-report:${kind}:${id}`);

  if (retry.ok) {
    const sendResult = retry.result;
    await recordMailLog({
      ts: Date.now(),
      from: from,
      to: [...toList, ...bccList],
      subject: emailSubject,
      resultId: sendResult?.id || null,
      kind: "item-report",
      status: "queued",
      scheduled_at: (payload.scheduledAt || (payload.scheduledAt || (payload.scheduledAt || payload.scheduled_at || null))),
      attachment: { filename, bytes: xlsxBuf.length },
    });
    return {
      ok: true,
      count: sorted.length,
      to: toList,
      bcc: bccList,
      scheduled_at: (payload.scheduledAt || (payload.scheduledAt || (payload.scheduledAt || payload.scheduled_at || null))),
    };
  }

  const err = retry.error;
  await recordMailLog({
    ts: Date.now(),
    from: from,
    to: [...toList, ...bccList],
    subject,
    resultId: null,
    kind: "item-report",
    status: "error",
    error: String(err?.message || err),
    scheduled_at: (payload.scheduledAt || (payload.scheduledAt || (payload.scheduledAt || payload.scheduled_at || null))),
  });
  return { ok: false, error: "send-failed", message: err?.message || String(err) };
}

// ---- real-time per-order chair emails for CATALOG items ----

export {
  collectAttendeesFromOrders,
  sendItemReportEmailInternal,
};
