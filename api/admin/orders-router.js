// /api/admin/orders-router.js
import {
  REQ_OK,
  REQ_ERR,
  kvGetSafe,
  kvSmembersSafe,
  flattenOrderToRows,
  getEffectiveSettings,
  parseYMD,
  filterRowsByWindow,
  baseKey,
  normalizeKey,
  sortByDateAsc,
  objectsToXlsxBuffer,
  collectAttendeesFromOrders,
  parseDateISO,
  renderOrderEmailHTML,
} from "./core.js";

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

export async function handleOrdersRoute(req, res, ctx = {}) {
  const { url, type, requestId, requireAdminAuth } = ctx;
  if (req.method !== "GET") return false;

  if (type === "customer_receipt") {
    const oid = String(url.searchParams.get("oid") || "").trim();
    const token = String(url.searchParams.get("token") || "").trim();
    if (!oid || !token) return REQ_ERR(res, 401, "receipt-access-denied", { requestId });

    const expectedHash = String(
      await kvGetSafe(`order:${oid}:receipt_view_hash`, "")
    ).trim();
    const suppliedHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const valid =
      expectedHash.length === suppliedHash.length &&
      expectedHash.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(suppliedHash));
    if (!valid) return REQ_ERR(res, 403, "receipt-access-denied", { requestId });

    const order = await kvGetSafe(`order:${oid}`, null);
    if (!order) return REQ_ERR(res, 404, "order-not-found", { requestId });
    const html = await renderOrderEmailHTML(order);
    return REQ_OK(res, {
      requestId,
      receipt: {
        id: order.id,
        amount_total: order.amount_total,
        currency: order.currency,
        customer_email: order.customer_email || order?.purchaser?.email || "",
        html: html || "",
      },
    });
  }

  const adminTypes = new Set([
    "orders",
    "orders_csv",
    "attendee_roster_csv",
    "directory_csv",
    "full_attendees_csv",
    "order",
    "order_receipt_html",
  ]);
  if (adminTypes.has(type)) {
    if (!(await requireAdminAuth(req, res))) return true;
  }

  if (type === "orders") {
        const ids = await kvSmembersSafe("orders:index");
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
        }

        const daysParam = url.searchParams.get("days");
        const startParam =
          url.searchParams.get("start") ||
          url.searchParams.get("from");
        const endParam =
          url.searchParams.get("end") ||
          url.searchParams.get("to");

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

        rows = sortByDateAsc(rows, "date");
        return REQ_OK(res, { requestId, rows });
      }

      if (type === "orders_csv") {
        // Download-safe XLSX export (null-safe + empty-safe)
        const ids = await kvSmembersSafe("orders:index");
        const all = [];

        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (!o) continue;

          const rows = flattenOrderToRows(o) || [];
          if (Array.isArray(rows)) {
            for (const r of rows) {
              if (r && typeof r === "object") all.push(r);
            }
          }
        }

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
          if (!isNaN(endMs) && /^\d{4}-\d{2}-\d{2}$/.test(String(endParam || ''))) endMs += 24 * 60 * 60 * 1000;
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs = endMs - Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
          } else {
            startMs = parseYMD(cfgStart);
            endMs = parseYMD(cfgEnd);
             if (!isNaN(endMs) && /^\d{4}-\d{2}-\d{2}$/.test(String(cfgEnd || ''))) endMs += 24 * 60 * 60 * 1000;
          }
        }

        let rows = all;

        if (!isNaN(startMs) || !isNaN(endMs)) {
          rows = filterRowsByWindow(rows, {
            startMs: isNaN(startMs) ? undefined : startMs,
            endMs: isNaN(endMs) ? undefined : endMs,
          });
        }

        const qSearch = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (qSearch) {
          rows = rows.filter(
            (r) =>
              String(r.purchaser || "").toLowerCase().includes(qSearch) ||
              String(r.attendee || "").toLowerCase().includes(qSearch) ||
              String(r.item || "").toLowerCase().includes(qSearch) ||
              String(r.category || "").toLowerCase().includes(qSearch) ||
              String(r.status || "").toLowerCase().includes(qSearch) ||
              String(r.notes || "").toLowerCase().includes(qSearch)
          );
        }

        const catParam = (url.searchParams.get("category") || "").toLowerCase();
        const itemIdParam = (url.searchParams.get("item_id") || "").toLowerCase();
        const itemParam = (url.searchParams.get("item") || "").toLowerCase();

        if (catParam) {
          rows = rows.filter((r) => String(r.category || "").toLowerCase() === catParam);
        }

        if (itemIdParam) {
          const wantRaw = itemIdParam;
          const wantBase = baseKey(wantRaw);
          const wantNorm = normalizeKey(wantRaw);

          rows = rows.filter((r) => {
            if (!r || typeof r !== "object") return false;
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
          rows = rows.filter((r) => String(r.item || "").toLowerCase().includes(want));
        }

        // --- XLSX safety: remove nulls + coerce cell values to primitives ---
        const safeRows = (Array.isArray(rows) ? rows : [])
          .filter((r) => r && typeof r === "object")
          .map((r) => {
            const out = {};
            for (const [k, v] of Object.entries(r)) {
              if (v === null || v === undefined) out[k] = "";
              else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
              else if (typeof v === "bigint") out[k] = v.toString();
              else if (v instanceof Date) out[k] = v.toISOString();
              else {
                try { out[k] = JSON.stringify(v); } catch { out[k] = String(v); }
              }
            }
            return out;
          });

        const sorted = sortByDateAsc(safeRows, "date").filter(
          (r) => r && typeof r === "object"
        );

        const fallback = {
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
          mode: "",
        };

        const easternRows = sorted.map((row) => ({
          ...row,
          date: formatEasternDateTime(row.date),
        }));
        let useRows = easternRows.length ? easternRows : [fallback];
        let headers = Object.keys(useRows[0] || fallback);
        let headerLabels = [];
        let sheetName = "Orders";

        // A transportation export should be a working transportation roster,
        // not a dump of every stored order, banquet, tour, and Stripe field.
        if (catParam === "transportation") {
          headers = [
            "id",
            "date",
            "purchaser",
            "passenger_count",
            "passenger_names",
            "passenger_phones",
            "passenger_emails",
            "pickup_needed",
            "pickup_airport",
            "pickup_airline",
            "pickup_flight",
            "pickup_datetime",
            "pickup_notes",
            "dropoff_needed",
            "dropoff_airport",
            "dropoff_airline",
            "dropoff_flight",
            "dropoff_datetime",
            "dropoff_notes",
            "notes",
          ];

          headerLabels = {
            id: "Order ID",
            date: "Order Date (Eastern)",
            purchaser: "Purchaser",
            passenger_count: "Passenger Count",
            passenger_names: "Passenger Names",
            passenger_phones: "Passenger Phones",
            passenger_emails: "Passenger Emails",
            pickup_needed: "Pickup Needed",
            pickup_airport: "Pickup Airport",
            pickup_airline: "Pickup Airline",
            pickup_flight: "Pickup Flight #",
            pickup_datetime: "Pickup Date & Time",
            pickup_notes: "Pickup Notes",
            dropoff_needed: "Drop-off Needed",
            dropoff_airport: "Drop-off Airport",
            dropoff_airline: "Drop-off Airline",
            dropoff_flight: "Drop-off Flight #",
            dropoff_datetime: "Drop-off Date & Time",
            dropoff_notes: "Drop-off Notes",
            notes: "Order Notes",
          };

          // Keep only transportation fields. Put the first passenger on the
          // main order row and list each additional passenger on a separate
          // detail row immediately below it.
          const splitPassengers = (value) =>
            String(value || "")
              .split(";")
              .map((part) => part.trim());

          const formatPhone = (value) => {
            const raw = String(value || "").trim();
            const digits = raw.replace(/\D/g, "");
            if (digits.length === 10) {
              return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
            }
            if (digits.length === 11 && digits.startsWith("1")) {
              return `1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
            }
            return raw;
          };

          useRows = useRows.flatMap((row) => {
            const names = splitPassengers(row?.passenger_names);
            const phones = splitPassengers(row?.passenger_phones);
            const emails = splitPassengers(row?.passenger_emails);
            const passengerTotal = Math.max(
              Number(row?.passenger_count || 0),
              names.filter(Boolean).length,
              phones.filter(Boolean).length,
              emails.filter(Boolean).length
            );

            const main = {};
            for (const key of headers) main[key] = row?.[key] ?? "";
            if (passengerTotal > 0) {
              main.passenger_names = names[0] || "";
              main.passenger_phones = formatPhone(phones[0] || "");
              main.passenger_emails = emails[0] || "";
            }

            const detailRows = [];
            for (let i = 1; i < passengerTotal; i++) {
              const detail = {};
              for (const key of headers) detail[key] = "";
              detail.passenger_names = names[i] || "";
              detail.passenger_phones = formatPhone(phones[i] || "");
              detail.passenger_emails = emails[i] || "";
              detailRows.push(detail);
            }

            return [main, ...detailRows];
          });
          sheetName = "Transportation";
        }

        let buf;
        try {
          buf = await objectsToXlsxBuffer(headers, useRows, headerLabels, sheetName);
        } catch (e) {
          console.error("orders_csv: failed to build XLSX (safe)", e);
          buf = await objectsToXlsxBuffer(Object.keys(fallback), [fallback], [], "Orders");
        }

        const fileParts = [];
        if (catParam) fileParts.push(catParam);
        if (itemIdParam) fileParts.push(itemIdParam);
        const fname = (fileParts.join("-") || "orders") + ".xlsx";

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        return res.status(200).send(buf);
      }

      if (type === "attendee_roster_csv") {
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
            if (!isNaN(endMs) && /^\d{4}-\d{2}-\d{2}$/.test(String(endParam || ''))) endMs += 24 * 60 * 60 * 1000;
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

        const sorted = sortByDateAsc(roster, "date")
          .filter((r) => r && typeof r === "object")
          .map((r) => ({ ...r, date: formatEasternDateTime(r.date) }));
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

        const buf = await objectsToXlsxBuffer(headers, sorted, [], "Attendees");
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

      if (type === "directory_csv") {
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

        const sorted = sortByDateAsc(roster, "date")
          .filter((r) => r && typeof r === "object")
          .map((r) => ({ ...r, date: formatEasternDateTime(r.date) }));
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

        const buf = await objectsToXlsxBuffer(headers, sorted, [], "Directory");
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="directory.xlsx"`);
        return res.status(200).send(buf);
      }

      if (type === "full_attendees_csv") {
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
          const key = `${norm(r.attendee)}|${norm(r.attendee_email)}|${normPhone(
            r.attendee_phone
          )}`;
          const prev = map.get(key);
          if (!prev) map.set(key, r);
          else {
            const tPrev = parseDateISO(prev.date);
            const tNew = parseDateISO(r.date);
            if (!isNaN(tNew) && !isNaN(tPrev) && tNew < tPrev) {
              map.set(key, r);
            }
          }
        }

        const unique = sortByDateAsc(Array.from(map.values()), "date").filter(
          (r) => r && typeof r === "object"
        );

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
          date: formatEasternDateTime(r.date),
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
          [],
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

      if (type === "order") {
        const oid = String(url.searchParams.get("oid") || "").trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid", { requestId });
        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found", { requestId });
        return REQ_OK(res, { requestId, order });
      }

      if (type === "order_receipt_html") {
        const oid =
          String(url.searchParams.get("oid") || url.searchParams.get("sid") || "")
            .trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid", { requestId });

        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found", { requestId });

        // renderOrderEmailHTML already knows how to format attendees + notes.
        const html = await renderOrderEmailHTML(order);
        return REQ_OK(res, { requestId, html: html || "" });
      }

  return false;
}
import crypto from "crypto";





