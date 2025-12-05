// admin/csv-reports.js

import {
  kvSmembersSafe,
  kvGetSafe,
  parseYMD,
  parseDateISO,
  sortByDateAsc,
  baseKey,
  normalizeKey,
  getEffectiveSettings,
  filterRowsByWindow,
  flattenOrderToRows,
  objectsToXlsxBuffer,
  collectAttendeesFromOrders,
} from "./core.js";

// Shared helper: load all flattened order rows
async function loadAllOrderRows() {
  const ids = await kvSmembersSafe("orders:index");
  const all = [];
  for (const sid of ids) {
    const o = await kvGetSafe(`order:${sid}`, null);
    if (o) all.push(...flattenOrderToRows(o));
  }
  return all;
}

/**
 * /api/router?type=orders_csv
 * Builds Orders XLSX (same logic as before, just moved here).
 */
async function handleOrdersCsv(url, res) {
  const all = await loadAllOrderRows();

  const daysParam = url.searchParams.get("days");
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");

  const { effective } = await getEffectiveSettings();
  const cfgDays = Number(effective.REPORT_ORDER_DAYS || 0) || 0;
  const cfgStart = effective.EVENT_START || "";
  const cfgEnd = effective.EVENT_END || "";

  let startMs = NaN;
  let endMs = NaN;

  if (daysParam) {
    const n = Math.max(1, Number(daysParam) || 0);
    endMs = Date.now() + 1;
    startMs = endMs - n * 24 * 60 * 60 * 1000;
  } else if (startParam || endParam) {
    startMs = parseYMD(startParam);
    endMs = parseYMD(endParam);
  } else if (cfgStart || cfgEnd || cfgDays) {
    if (cfgDays) {
      endMs = Date.now() + 1;
      startMs =
        endMs - Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
    } else {
      startMs = parseYMD(cfgStart);
      endMs = parseYMD(cfgEnd);
    }
  }

  let rows = all;
  if (!isNaN(startMs) || !isNaN(endMs)) {
    rows = filterRowsByWindow(rows, {
      startMs: isNaN(startMs) ? undefined : startMs,
      endMs: isNaN(endMs) ? undefined : endMs,
    });
  }

  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.purchaser || "").toLowerCase().includes(q) ||
        String(r.attendee || "").toLowerCase().includes(q) ||
        String(r.item || "").toLowerCase().includes(q) ||
        String(r.category || "").toLowerCase().includes(q) ||
        String(r.status || "").toLowerCase().includes(q) ||
        String(r.notes || "").toLowerCase().includes(q)
    );
  }

  const catParam = (url.searchParams.get("category") || "").toLowerCase();
  const itemIdParam = (url.searchParams.get("item_id") || "").toLowerCase();
  const itemParam = (url.searchParams.get("item") || "").toLowerCase();

  if (catParam) {
    rows = rows.filter(
      (r) => String(r.category || "").toLowerCase() === catParam
    );
  }

  if (itemIdParam) {
    const wantRaw = itemIdParam;
    const wantBase = baseKey(wantRaw);
    const wantNorm = normalizeKey(wantRaw);
    rows = rows.filter((r) => {
      const raw = String(r._itemId || r.item_id || "").toLowerCase();
      const rawNorm = normalizeKey(raw);
      const keyBase = baseKey(raw);
      const rowBase = r._itemBase || keyBase;
      return (
        raw === wantRaw ||
        rawNorm === wantNorm ||
        keyBase === wantBase ||
        rowBase === wantBase ||
        String(r._itemKey || "").toLowerCase() === wantNorm
      );
    });
  } else if (itemParam) {
    const want = itemParam;
    rows = rows.filter((r) =>
      String(r.item || "").toLowerCase().includes(want)
    );
  }

  const sorted = sortByDateAsc(rows, "date");
  const headers = Object.keys(
    sorted[0] || {
      id: "",
      date: "",
      purchaser: "",
      attendee: "",
      category: "",
      item: "",
      item_id: "",
      qty: 0,
      price: 0,
      gross: 0,
      fees: 0,
      net: 0,
      status: "",
      notes: "",
      _itemId: "",
      _itemBase: "",
      _itemKey: "",
      _pi: "",
      _charge: "",
      _session: "",
    }
  );

  const buf = await objectsToXlsxBuffer(headers, sorted, null, "Orders");

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="orders.xlsx"`);
  return res.status(200).send(buf);
}

/**
 * /api/router?type=attendee_roster_csv
 */
async function handleAttendeeRosterCsv(url, res) {
  const ids = await kvSmembersSafe("orders:index");
  const orders = [];
  for (const sid of ids) {
    const o = await kvGetSafe(`order:${sid}`, null);
    if (o) orders.push(o);
  }

  const daysParam = url.searchParams.get("days");
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  let startMs = NaN,
    endMs = NaN;

  if (daysParam) {
    const n = Math.max(1, Number(daysParam) || 0);
    endMs = Date.now() + 1;
    startMs = endMs - n * 24 * 60 * 60 * 1000;
  } else if (startParam || endParam) {
    startMs = parseYMD(startParam);
    endMs = parseYMD(endParam);
  }

  const cats = (url.searchParams.get("category") || "banquet,addon")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const roster = collectAttendeesFromOrders(orders, {
    includeAddress: false,
    categories: cats,
    startMs: isNaN(startMs) ? undefined : startMs,
    endMs: isNaN(endMs) ? undefined : endMs,
  });

  const sorted = sortByDateAsc(roster, "date");
  const headers = [
    "date",
    "purchaser",
    "attendee",
    "attendee_title",
    "attendee_phone",
    "attendee_email",
    "item",
    "item_id",
    "qty",
    "notes",
  ];

  const buf = await objectsToXlsxBuffer(headers, sorted, null, "Attendees");

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="attendee-roster.xlsx"`
  );
  return res.status(200).send(buf);
}

/**
 * /api/router?type=directory_csv
 */
async function handleDirectoryCsv(url, res) {
  const ids = await kvSmembersSafe("orders:index");
  const orders = [];
  for (const sid of ids) {
    const o = await kvGetSafe(`order:${sid}`, null);
    if (o) orders.push(o);
  }

  const daysParam = url.searchParams.get("days");
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  let startMs = NaN,
    endMs = NaN;

  if (daysParam) {
    const n = Math.max(1, Number(daysParam) || 0);
    endMs = Date.now() + 1;
    startMs = endMs - n * 24 * 60 * 60 * 1000;
  } else if (startParam || endParam) {
    startMs = parseYMD(startParam);
    endMs = parseYMD(endParam);
  }

  const cats = (url.searchParams.get("category") || "banquet,addon")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const roster = collectAttendeesFromOrders(orders, {
    includeAddress: true,
    categories: cats,
    startMs: isNaN(startMs) ? undefined : startMs,
    endMs: isNaN(endMs) ? undefined : endMs,
  });

  const sorted = sortByDateAsc(roster, "date");
  const headers = [
    "attendee",
    "attendee_title",
    "attendee_email",
    "attendee_phone",
    "attendee_addr1",
    "attendee_addr2",
    "attendee_city",
    "attendee_state",
    "attendee_postal",
    "attendee_country",
    "item",
    "qty",
    "notes",
    "purchaser",
    "date",
  ];

  const buf = await objectsToXlsxBuffer(headers, sorted, null, "Directory");

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="directory.xlsx"`
  );
  return res.status(200).send(buf);
}

/**
 * /api/router?type=full_attendees_csv
 * One unique line per attendee (earliest purchase), with address.
 */
async function handleFullAttendeesCsv(url, res) {
  const ids = await kvSmembersSafe("orders:index");
  const orders = [];
  for (const sid of ids) {
    const o = await kvGetSafe(`order:${sid}`, null);
    if (o) orders.push(o);
  }

  const daysParam = url.searchParams.get("days");
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  let startMs = NaN,
    endMs = NaN;

  if (daysParam) {
    const n = Math.max(1, Number(daysParam) || 0);
    endMs = Date.now() + 1;
    startMs = endMs - n * 24 * 60 * 60 * 1000;
  } else if (startParam || endParam) {
    startMs = parseYMD(startParam);
    endMs = parseYMD(endParam);
  }

  const cats = (url.searchParams.get("category") || "banquet,addon")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rosterAll = collectAttendeesFromOrders(orders, {
    includeAddress: true,
    categories: cats,
    startMs: isNaN(startMs) ? undefined : startMs,
    endMs: isNaN(endMs) ? undefined : endMs,
  });

  const withAttendee = rosterAll.filter(
    (r) => String(r.attendee || "").trim().length > 0
  );

  const norm = (s) => String(s || "").trim().toLowerCase();
  const normPhone = (s) => String(s || "").replace(/\D+/g, "");
  const map = new Map();

  for (const r of withAttendee) {
    const key = `${norm(r.attendee)}|${norm(
      r.attendee_email
    )}|${normPhone(r.attendee_phone)}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
    } else {
      const tPrev = parseDateISO(prev.date);
      const tNew = parseDateISO(r.date);
      if (!isNaN(tNew) && !isNaN(tPrev) && tNew < tPrev) {
        map.set(key, r);
      }
    }
  }

  const unique = sortByDateAsc(Array.from(map.values()), "date");

  const headers = [
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
  ];

  const numbered = unique.map((r, idx) => ({
    "#": idx + 1,
    date: r.date,
    attendee: r.attendee,
    attendee_title: r.attendee_title,
    attendee_phone: r.attendee_phone,
    attendee_email: r.attendee_email,
    attendee_addr1: r.attendee_addr1,
    attendee_addr2: r.attendee_addr2,
    attendee_city: r.attendee_city,
    attendee_state: r.attendee_state,
    attendee_postal: r.attendee_postal,
    attendee_country: r.attendee_country,
  }));

  const buf = await objectsToXlsxBuffer(
    headers,
    numbered,
    null,
    "Full Attendees"
  );

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="full-attendees.xlsx"`
  );
  return res.status(200).send(buf);
}

/**
 * Main dispatcher called from router.js
 */
export async function handleCsvExport(type, url, res) {
  if (type === "orders_csv") {
    return handleOrdersCsv(url, res);
  }
  if (type === "attendee_roster_csv") {
    return handleAttendeeRosterCsv(url, res);
  }
  if (type === "directory_csv") {
    return handleDirectoryCsv(url, res);
  }
  if (type === "full_attendees_csv") {
    return handleFullAttendeesCsv(url, res);
  }

  return res
    .status(400)
    .json({ ok: false, error: "unknown-csv-type", type });
}