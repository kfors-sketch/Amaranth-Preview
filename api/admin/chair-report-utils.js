// /api/admin/chair-report-utils.js
import { kvGetSafe, kvHgetallSafe, kvSetSafe, kvSmembersSafe } from "./kv-utils.js";
import { resend, RESEND_FROM, REPLY_TO, sendWithRetry, recordMailLog, nextReportScheduledAtIso } from "./mail-utils.js";
import { objectsToXlsxBuffer } from "./export-utils.js";
import { parseYMD, sortByDateAsc, baseKey, formatCoverageRange } from "./report-utils.js";
import { loadAllOrdersWithRetry, collectAttendeesFromOrders } from "./order-utils.js";
import { getEffectiveSettings } from "./settings-utils.js";

function formatEasternDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(parsed);
}

// ----- Chair email resolution -----
export async function getChairEmailsForItemId(id) {
  const safeSplit = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  try {
    const banquets = await kvGetSafe("banquets", []);
    if (Array.isArray(banquets)) {
      const b = banquets.find((x) => String(x?.id || "") === String(id));
      if (b) {
        const arr = Array.isArray(b.chairEmails)
          ? b.chairEmails
          : safeSplit(b.chairEmails || b?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  try {
    const addons = await kvGetSafe("addons", []);
    if (Array.isArray(addons)) {
      const a = addons.find((x) => String(x?.id || "") === String(id));
      if (a) {
        const arr = Array.isArray(a.chairEmails)
          ? a.chairEmails
          : safeSplit(a.chairEmails || a?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  try {
    const tours = await kvGetSafe("tours", []);
    if (Array.isArray(tours)) {
      const t = tours.find((x) => String(x?.id || "") === String(id));
      if (t) {
        const arr = Array.isArray(t.chairEmails)
          ? t.chairEmails
          : safeSplit(t.chairEmails || t?.chair?.email || "");
        if (arr.length) return arr;
      }
    }
  } catch {}

  const cfg = await kvHgetallSafe(`itemcfg:${id}`);
  const legacyArr = Array.isArray(cfg?.chairEmails)
    ? cfg.chairEmails
    : safeSplit(cfg?.chairEmails || "");
  return legacyArr;
}

// Order persistence/refund/flatten helpers moved to ./order-utils.js

// ---------------------------------------------------------------------------
// Combine Directory + Proceedings rows (presentation only; no storage changes)
// ---------------------------------------------------------------------------
export function combineDirectoryProceedingsRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Map();

  const keyOf = (r) => [
    String(r?.date || ""),
    String(r?.attendee || ""),
    String(r?.attendee_title || ""),
    String(r?.attendee_phone || ""),
    String(r?.attendee_email || ""),
    String(r?.court || ""),
    String(r?.court_number || ""),
    String(r?.attendee_addr1 || ""),
    String(r?.attendee_addr2 || ""),
    String(r?.attendee_city || ""),
    String(r?.attendee_state || ""),
    String(r?.attendee_postal || ""),
    String(r?.attendee_country || ""),
    String(r?.id || ""),
  ].join("|");

  const pushNote = (parts, val) => {
    const s = String(val || "").trim();
    if (!s) return;
    if (!parts.includes(s)) parts.push(s);
  };

  for (const r of list) {
    const itemBase = baseKey(r?.item_id || r?._itemId || r?.item || "");
    if (itemBase !== "directory" && itemBase !== "proceedings") continue;

    const key = keyOf(r);
    if (!out.has(key)) {
      out.set(key, {
        ...r,
        directory: "",
        directory_qty: "",
        proceedings: "",
        proceedings_qty: "",
        directory_cost_value: 0,
        proceedings_cost_value: 0,
        notes_parts: [],
      });
    }

    const row = out.get(key);
    const qty = Number(r?.qty || 0);
    const gross = Number(r?.gross || 0);
    if (itemBase === "directory") {
      row.directory = "Directory";
      row.directory_qty = Number(row.directory_qty || 0) + qty;
      row.directory_cost_value = Number(row.directory_cost_value || 0) + gross;
    }
    if (itemBase === "proceedings") {
      row.proceedings = "Proceedings";
      row.proceedings_qty = Number(row.proceedings_qty || 0) + qty;
      row.proceedings_cost_value = Number(row.proceedings_cost_value || 0) + gross;
    }
    pushNote(row.notes_parts, r?.notes);
  }

  return Array.from(out.values()).map((row) => {
    const next = { ...row };
    next.notes = (next.notes_parts || []).join("; ");
    delete next.notes_parts;
    if (!next.directory_qty) next.directory_qty = "";
    if (!next.proceedings_qty) next.proceedings_qty = "";
    return next;
  });
}

// --- Helper to estimate Stripe fee from items + shipping ---
// Receipt email / receipt XLSX helpers moved to ./receipt-utils.js

// Attendee roster collector moved to ./order-utils.js

// ---------------------------------------------------------------------------
// Chair report sender (attachment-hardened + scheduled_at safety)
// ---------------------------------------------------------------------------

export async function sendItemReportEmailInternal({
  kind,
  id,
  label,
  scope = "current-month",
  startDate,
  endDate,
  // Accept admin UI aliases
  startYMD,
  endYMD,
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
    if (startDate || startYMD) {
      const dStart = parseYMD(startDate || startYMD);
      if (!isNaN(dStart)) startMs = dStart;
    }
    if (endDate || endYMD) {
      const dEnd = parseYMD(endDate || endYMD);
      if (!isNaN(dEnd)) endMs = dEnd + 24 * 60 * 60 * 1000;
    }
  }

  const base = baseKey(id);
  const includeAddressForThisItem = base === "pre-reg" || base === "directory" || base === "proceedings";
  const isLoveGiftBase = /(^|[-_])(love|gift|lovegift|love-gift)s?($|[-_])/.test(base);
  const isCorsageBase = /(corsage|boutonniere)/.test(base);
  const isBanquetKind = String(kind || "").toLowerCase() === "banquet";
  const isTransportationKind = String(kind || "").toLowerCase() === "transportation";
  const isTourKind = String(kind || "").toLowerCase() === "tour" || String(kind || "").toLowerCase() === "tours";
  const isPreRegBase = base === "pre-reg";
  const isDirectoryBase = base === "directory";
  const isProceedingsBase = base === "proceedings";
  const isDirectoryProceedingsCombined = isDirectoryBase || isProceedingsBase;

  const rosterAll = collectAttendeesFromOrders(ordersForMode, {
    includeAddress: includeAddressForThisItem,
    categories: [String(kind).toLowerCase()],
    startMs,
    endMs,
  });

  const wantBase = (s) => String(s || "").toLowerCase().split(":")[0];
  let filtered = rosterAll.filter((r) => {
    const rowBase = wantBase(r.item_id || r._itemId || r.item || "");
    if (isDirectoryProceedingsCombined) {
      return rowBase === "directory" || rowBase === "proceedings";
    }
    return (
      rowBase === wantBase(id) ||
      (!r.item_id &&
        label &&
        String(r.item || "").toLowerCase().includes(String(label).toLowerCase()))
    );
  });

  if (isDirectoryProceedingsCombined) {
    filtered = combineDirectoryProceedingsRows(filtered);
  }

  let EMAIL_COLUMNS = ["#", "date", "attendee", "attendee_title", "attendee_phone", "item", "qty", "notes"];
  let EMAIL_HEADER_LABELS = {
    "#": "#",
    date: "Order Date (Eastern)",
    attendee: "Attendee",
    attendee_title: "Title",
    attendee_phone: "Phone",
    item: "Item",
    qty: "Qty",
    notes: "Notes",
  };

  if (isTransportationKind) {
    EMAIL_COLUMNS = [
      "#", "date", "item", "qty",
      "passenger_count", "passenger_names", "passenger_phones", "passenger_emails",
      "pickup_needed", "pickup_airport", "pickup_airline", "pickup_flight", "pickup_datetime", "pickup_notes",
      "dropoff_needed", "dropoff_airport", "dropoff_airline", "dropoff_flight", "dropoff_datetime", "dropoff_notes",
      "notes"
    ];
    EMAIL_HEADER_LABELS = {
      "#": "#", date: "Order Date (Eastern)", item: "Transportation", qty: "Qty",
      passenger_count: "Passenger Count", passenger_names: "Passenger Names", passenger_phones: "Passenger Phones", passenger_emails: "Passenger Emails",
      pickup_needed: "Pickup Needed", pickup_airport: "Pickup Airport", pickup_airline: "Pickup Airline", pickup_flight: "Pickup Flight", pickup_datetime: "Pickup Date/Time", pickup_notes: "Pickup Notes",
      dropoff_needed: "Drop-off Needed", dropoff_airport: "Drop-off Airport", dropoff_airline: "Drop-off Airline", dropoff_flight: "Drop-off Flight", dropoff_datetime: "Drop-off Date/Time", dropoff_notes: "Drop-off Notes",
      notes: "Notes"
    };
  }

  if (isTourKind) {
    EMAIL_COLUMNS = ["#", "date", "attendee", "attendee_title", "tour_cell_phone", "attendee_email", "court", "court_number", "item", "tour_datetime", "tour_location", "tour_accessibility", "qty", "notes"];
    EMAIL_HEADER_LABELS = {
      "#": "#", date: "Order Date (Eastern)", attendee: "Attendee", attendee_title: "Title",
      tour_cell_phone: "Cell Phone", attendee_email: "Email", court: "Court", court_number: "Court #",
      item: "Tour", tour_datetime: "Tour Date/Time", tour_location: "Meeting Location", tour_accessibility: "Mobility / Accessibility",
      qty: "Qty", notes: "Notes"
    };
  }

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
      date: "Order Date (Eastern)",
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

  if (isDirectoryProceedingsCombined) {
    EMAIL_COLUMNS = [
      "#",
      "date",
      "directory",
      "directory_qty",
      "proceedings",
      "proceedings_qty",
      "attendee",
      "attendee_title",
      "attendee_phone",
      "court",
      "court_number",
      "attendee_email",
      "attendee_addr1",
      "attendee_addr2",
      "attendee_city",
      "attendee_state",
      "attendee_postal",
      "attendee_country",
      "notes",
    ];
    EMAIL_HEADER_LABELS = {
      "#": "#",
      date: "Order Date (Eastern)",
      attendee: "Attendee",
      attendee_title: "Title",
      attendee_phone: "Phone",
      court: "Court",
      court_number: "Court #",
      attendee_email: "Email",
      attendee_addr1: "Address 1",
      attendee_addr2: "Address 2",
      attendee_city: "City",
      attendee_state: "State",
      attendee_postal: "Postal",
      attendee_country: "Country",
      directory: "Directory",
      directory_qty: "Qty",
      proceedings: "Proceedings",
      proceedings_qty: "Qty",
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
      date: formatEasternDateTime(r.date),
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


    if ((EMAIL_COLUMNS || []).includes("tour_cell_phone")) baseRow.tour_cell_phone = r.tour_cell_phone || r.attendee_phone || "";
    if ((EMAIL_COLUMNS || []).includes("tour_datetime")) baseRow.tour_datetime = r.tour_datetime || "";
    if ((EMAIL_COLUMNS || []).includes("tour_location")) baseRow.tour_location = r.tour_location || "";
    if ((EMAIL_COLUMNS || []).includes("tour_accessibility")) baseRow.tour_accessibility = r.tour_accessibility || "";
    if ((EMAIL_COLUMNS || []).includes("passenger_count")) baseRow.passenger_count = r.passenger_count || "";
    if ((EMAIL_COLUMNS || []).includes("passenger_names")) baseRow.passenger_names = r.passenger_names || "";
    if ((EMAIL_COLUMNS || []).includes("passenger_phones")) baseRow.passenger_phones = r.passenger_phones || "";
    if ((EMAIL_COLUMNS || []).includes("passenger_emails")) baseRow.passenger_emails = r.passenger_emails || "";
    for (const key of ["pickup_needed","pickup_airport","pickup_airline","pickup_flight","pickup_datetime","pickup_notes","dropoff_needed","dropoff_airport","dropoff_airline","dropoff_flight","dropoff_datetime","dropoff_notes"]) {
      if ((EMAIL_COLUMNS || []).includes(key)) baseRow[key] = r[key] || "";
    }

    if (isPreRegBase) {
      baseRow.voting_status = deriveVotingStatus(r);
    }

    const itemFields = isDirectoryProceedingsCombined
      ? {
          directory: r.directory || "",
          directory_qty: r.directory_qty || "",
          proceedings: r.proceedings || "",
          proceedings_qty: r.proceedings_qty || "",
        }
      : isLoveGiftBase
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
        ...(isDirectoryProceedingsCombined ? {} : { qty: r.qty }),
        notes: r.notes,
      };
    }

    return { ...baseRow, ...itemFields, ...(isDirectoryProceedingsCombined ? {} : { qty: r.qty }), notes: r.notes };
  });

  if (isDirectoryProceedingsCombined) {
    const colLetter = (n) => {
      let s = "";
      let x = Number(n || 0);
      while (x > 0) {
        const rem = (x - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        x = Math.floor((x - 1) / 26);
      }
      return s || "A";
    };

    const dirQtyCol = colLetter((EMAIL_COLUMNS || []).indexOf("directory_qty") + 1);
    const procQtyCol = colLetter((EMAIL_COLUMNS || []).indexOf("proceedings_qty") + 1);

    if (dirQtyCol && procQtyCol && numbered.length > 0) {
      // With spacerRows:true, each data row is followed by a blank row.
      // Data occupies rows 2..(2*n), with blanks in between; the totals row is added after that.
      const lastDataScanRow = numbered.length * 2;

      const coerceDollarPrice = (obj) => {
        if (!obj || typeof obj !== "object") return 0;
        const candidates = [
          obj.price,
          obj.unitPrice,
          obj.amount,
          obj.cost,
          obj.value,
          obj.priceDollars,
          obj.price_dollars,
          obj.unit_price,
          obj.price_cents,
          obj.unitPriceCents,
          obj.unit_price_cents,
        ];
        for (const raw of candidates) {
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) continue;
          return n > 1000 ? Number((n / 100).toFixed(2)) : n;
        }
        return 0;
      };

      const configuredPriceFor = async (baseId, labelText) => {
        const wantBase = baseKey(baseId);
        const wantLabel = String(labelText || "").trim().toLowerCase();

        try {
          const addons = (await kvGetSafe("addons", [])) || [];
          if (Array.isArray(addons)) {
            const exact = addons.find((a) => {
              const ids = [
                a?.id,
                a?.itemId,
                a?.item_id,
                a?.slotKey,
                a?.slot,
                a?.key,
              ]
                .map((v) => baseKey(v))
                .filter(Boolean);
              return ids.includes(wantBase);
            });
            const fuzzy = !exact
              ? addons.find((a) => {
                  const txt = [
                    a?.name,
                    a?.label,
                    a?.title,
                    a?.itemName,
                    a?.item_name,
                  ]
                    .map((v) => String(v || "").toLowerCase())
                    .join(" ");
                  return wantLabel && txt.includes(wantLabel);
                })
              : null;

            const picked = exact || fuzzy;
            const fromAddons = coerceDollarPrice(picked);
            if (fromAddons > 0) return fromAddons;
          }
        } catch {}

        try {
          const directCfg = await kvHgetallSafe(`itemcfg:${wantBase}`);
          const fromDirect = coerceDollarPrice(directCfg);
          if (fromDirect > 0) return fromDirect;
        } catch {}

        try {
          const idx = (await kvSmembersSafe("itemcfg:index")) || [];
          for (const rawId of idx) {
            const rawBase = baseKey(rawId);
            const rawText = String(rawId || "").toLowerCase();
            if (rawBase !== wantBase && !(wantLabel && rawText.includes(wantLabel))) continue;
            const cfg = await kvHgetallSafe(`itemcfg:${rawId}`);
            const price = coerceDollarPrice(cfg);
            if (price > 0) return price;
          }
        } catch {}

        return 0;
      };

      const directoryPrice = await configuredPriceFor("directory", "directory");
      const proceedingsPrice = await configuredPriceFor("proceedings", "proceedings");

      numbered.push({
        "#": "",
        date: "",
        directory: "TOTAL QTY",
        directory_qty: { formula: `SUM(${dirQtyCol}2:${dirQtyCol}${lastDataScanRow})` },
        proceedings: "TOTAL QTY",
        proceedings_qty: { formula: `SUM(${procQtyCol}2:${procQtyCol}${lastDataScanRow})` },
        attendee: "",
        attendee_title: "",
        attendee_phone: "",
        court: "",
        court_number: "",
        attendee_email: "",
        attendee_addr1: "",
        attendee_addr2: "",
        attendee_city: "",
        attendee_state: "",
        attendee_postal: "",
        attendee_country: "",
        notes: "",
      });

      numbered.push({
        "#": "",
        date: "",
        directory: "TOTAL COST",
        directory_qty: {
          formula: `SUM(${dirQtyCol}2:${dirQtyCol}${lastDataScanRow})*${directoryPrice || 0}`,
          numFmt: '$#,##0.00'
        },
        proceedings: "TOTAL COST",
        proceedings_qty: {
          formula: `SUM(${procQtyCol}2:${procQtyCol}${lastDataScanRow})*${proceedingsPrice || 0}`,
          numFmt: '$#,##0.00'
        },
        attendee: "",
        attendee_title: "",
        attendee_phone: "",
        court: "",
        court_number: "",
        attendee_email: "",
        attendee_addr1: "",
        attendee_addr2: "",
        attendee_city: "",
        attendee_state: "",
        attendee_postal: "",
        attendee_country: "",
        notes: "",
      });

      numbered.push({
        "#": "",
        date: "",
        directory: "COMBINED COST",
        directory_qty: {
          formula: `(SUM(${dirQtyCol}2:${dirQtyCol}${lastDataScanRow})*${directoryPrice || 0})+(SUM(${procQtyCol}2:${procQtyCol}${lastDataScanRow})*${proceedingsPrice || 0})`,
          numFmt: '$#,##0.00'
        },
        proceedings: "",
        proceedings_qty: "",
        attendee: "",
        attendee_title: "",
        attendee_phone: "",
        court: "",
        court_number: "",
        attendee_email: "",
        attendee_addr1: "",
        attendee_addr2: "",
        attendee_city: "",
        attendee_state: "",
        attendee_postal: "",
        attendee_country: "",
        notes: "",
      });
    }
  }


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
  const reportLabel = isDirectoryProceedingsCombined ? "Directory & Proceedings" : (label || id || "report");
  const reportIdForFile = isDirectoryProceedingsCombined ? "directory_proceedings" : (id || "item");
  const baseNameRaw = reportLabel;
  const baseName = baseNameRaw.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  const filename = `Report_${reportIdForFile}_${scope || "current"}.xlsx`;

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

  const subject = `Report — ${prettyKind}: ${reportLabel}`;
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
export const REALTIME_CHAIR_KEY_PREFIX = "order:catalog_chairs_sent:";

export async function sendRealtimeChairEmailsForOrder(order) {
  if (!order || !Array.isArray(order.lines)) return { sent: 0 };
  const seen = new Set();
  let sent = 0;

  for (const li of order.lines) {
    const cat = String(li.category || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();
    const isCatalog = cat === "catalog" || metaType === "catalog";
    if (!isCatalog) continue;

    const id = String(li.itemId || "").trim();
    if (!id) continue;

    const key = `${cat}:${baseKey(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = li.itemName || id;

    const result = await sendItemReportEmailInternal({
      kind: cat || "catalog",
      id,
      label,
      scope: "full",
    });

    if (result.ok) sent += 1;
  }

  return { sent };
}

export async function maybeSendRealtimeChairEmails(order) {
  if (!order?.id) return;
  const key = `${REALTIME_CHAIR_KEY_PREFIX}${order.id}`;
  const already = await kvGetSafe(key, null);
  if (already) return;

  try {
    await sendRealtimeChairEmailsForOrder(order);
    await kvSetSafe(key, new Date().toISOString());
  } catch (e) {
    console.error("realtime-chair-email-failed", e?.message || e);
  }
}
