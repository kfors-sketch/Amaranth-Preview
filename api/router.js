// /api/router.js
import {
  kv,
  getStripe,
  resend,
  RESEND_FROM,
  REPLY_TO,
  REPORTS_LOG_TO,
  CONTACT_TO,
  REQ_OK,
  REQ_ERR,
  cents,
  dollarsToCents,
  toCentsAuto,
  kvGetSafe,
  kvHsetSafe,
  kvSaddSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvSmembersSafe,
  kvDelSafe,
  sendWithRetry,
  loadAllOrdersWithRetry,
  parseDateISO,
  parseYMD,
  sortByDateAsc,
  baseKey,
  normalizeKey,
  getEffectiveSettings,
  filterRowsByWindow,
  applyItemFilters,
  MAIL_LOG_KEY,
  recordMailLog,
  fetchSessionAndItems,
  getChairEmailsForItemId,
  saveOrderFromSession,
  applyRefundToOrder,
  flattenOrderToRows,
  absoluteUrl,
  renderOrderEmailHTML,
  sendOrderReceipts,
  buildCSV,
  buildCSVSelected,
  objectsToXlsxBuffer,
  collectAttendeesFromOrders,
  sendItemReportEmailInternal,
  REALTIME_CHAIR_KEY_PREFIX,
  sendRealtimeChairEmailsForOrder,
  maybeSendRealtimeChairEmails,
} from "./admin/core.js";

import {
  isInternationalOrder,
  computeInternationalFeeCents,
  buildInternationalFeeLineItem,
} from "./admin/fees.js";

// Simple bearer auth for admin writes
function requireToken(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== (process.env.REPORT_TOKEN || "")) {
    REQ_ERR(res, 401, "unauthorized");
    return false;
  }
  return true;
}

// -------------- main handler --------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get("action");
    const type = url.searchParams.get("type");

    // ---------- GET ----------
    if (req.method === "GET") {
      if (type === "smoketest") {
        const out = {
          ok: true,
          node: process.versions?.node || "unknown",
          runtime: process.env.VERCEL ? "vercel" : "local",
          hasSecret: !!process.env.STRIPE_SECRET_KEY,
          hasPub: !!process.env.STRIPE_PUBLISHABLE_KEY,
          hasWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
          hasResendEnv: !!process.env.RESEND_API_KEY,
          hasResendClient: !!resend,
          fromTrimmed: RESEND_FROM,
          kvSetGetOk: false,
        };
        try {
          await kv.set("smoketest:key", "ok", { ex: 30 });
        } catch {}
        try {
          const v = await kv.get("smoketest:key");
          out.kvSetGetOk = v === "ok";
        } catch (e) {
          out.kvError = String(e?.message || e);
        }
        return REQ_OK(res, out);
      }

      if (type === "lastmail") {
        const data = await kvGetSafe(MAIL_LOG_KEY, {
          note: "no recent email log",
        });
        return REQ_OK(res, data);
      }

      if (type === "banquets")
        return REQ_OK(res, { banquets: (await kvGetSafe("banquets")) || [] });
      if (type === "addons")
        return REQ_OK(res, { addons: (await kvGetSafe("addons")) || [] });
      if (type === "products")
        return REQ_OK(res, { products: (await kvGetSafe("products")) || [] });

      if (type === "settings") {
        const { env, overrides, effective } = await getEffectiveSettings();
        return REQ_OK(res, {
          env,
          overrides,
          effective,
          MAINTENANCE_ON: effective.MAINTENANCE_ON,
          MAINTENANCE_MESSAGE:
            effective.MAINTENANCE_MESSAGE || env.MAINTENANCE_MESSAGE,
        });
      }

      if (type === "stripe_pubkey" || type === "stripe_pk") {
        return REQ_OK(res, {
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
        });
      }

      if (type === "checkout_session") {
        const stripe = await getStripe();
        if (!stripe) return REQ_ERR(res, 500, "stripe-not-configured");
        const id = url.searchParams.get("id");
        if (!id) return REQ_ERR(res, 400, "missing-id");
        const s = await stripe.checkout.sessions.retrieve(id, {
          expand: ["payment_intent"],
        });
        return REQ_OK(res, {
          id: s.id,
          amount_total: s.amount_total,
          currency: s.currency,
          customer_details: s.customer_details || {},
          payment_intent:
            typeof s.payment_intent === "string"
              ? s.payment_intent
              : s.payment_intent?.id,
        });
      }

      if (type === "orders") {
        const ids = await kvSmembersSafe("orders:index");
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
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
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs =
              endMs -
              Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
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

        const q = (url.searchParams.get("q") || "")
          .trim()
          .toLowerCase();
        if (q) {
          rows = rows.filter(
            (r) =>
              String(r.purchaser || "")
                .toLowerCase()
                .includes(q) ||
              String(r.attendee || "").toLowerCase().includes(q) ||
              String(r.item || "").toLowerCase().includes(q) ||
              String(r.category || "")
                .toLowerCase()
                .includes(q) ||
              String(r.status || "").toLowerCase().includes(q) ||
              String(r.notes || "").toLowerCase().includes(q)
          );
        }

        const catParam = (
          url.searchParams.get("category") || ""
        ).toLowerCase();
        const itemIdParam = (
          url.searchParams.get("item_id") || ""
        ).toLowerCase();
        const itemParam = (
          url.searchParams.get("item") || ""
        ).toLowerCase();

        if (catParam) {
          rows = rows.filter(
            (r) =>
              String(r.category || "").toLowerCase() === catParam
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

        return REQ_OK(res, { rows });
      }

      if (type === "orders_csv") {
        const ids = await kvSmembersSafe("orders:index");
        const all = [];
        for (const sid of ids) {
          const o = await kvGetSafe(`order:${sid}`, null);
          if (o) all.push(...flattenOrderToRows(o));
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
        } else if (cfgStart || cfgEnd || cfgDays) {
          if (cfgDays) {
            endMs = Date.now() + 1;
            startMs =
              endMs -
              Math.max(1, Number(cfgDays)) * 24 * 60 * 60 * 1000;
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

        const q = (url.searchParams.get("q") || "")
          .trim()
          .toLowerCase();
        if (q) {
          rows = rows.filter(
            (r) =>
              String(r.purchaser || "")
                .toLowerCase()
                .includes(q) ||
              String(r.attendee || "").toLowerCase().includes(q) ||
              String(r.item || "").toLowerCase().includes(q) ||
              String(r.category || "")
                .toLowerCase()
                .includes(q) ||
              String(r.status || "").toLowerCase().includes(q) ||
              String(r.notes || "").toLowerCase().includes(q)
          );
        }

        const catParam = (
          url.searchParams.get("category") || ""
        ).toLowerCase();
        const itemIdParam = (
          url.searchParams.get("item_id") || ""
        ).toLowerCase();
        const itemParam = (
          url.searchParams.get("item") || ""
        ).toLowerCase();

        if (catParam) {
          rows = rows.filter(
            (r) =>
              String(r.category || "").toLowerCase() === catParam
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

        const buf = await objectsToXlsxBuffer(
          headers,
          sorted,
          null,
          "Orders"
        );

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="orders.xlsx"`
        );
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

        const buf = await objectsToXlsxBuffer(
          headers,
          sorted,
          null,
          "Attendees"
        );
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

        const buf = await objectsToXlsxBuffer(
          headers,
          sorted,
          null,
          "Directory"
        );
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
          const key = `${norm(r.attendee)}|${norm(
            r.attendee_email
          )}|${normPhone(r.attendee_phone)}`;
          const prev = map.get(key);
          if (!prev) {
            map.set(key, r);
          } else {
            const tPrev = parseDateISO(prev.date);
            const tNew = parseDateISO(r.date);
            if (
              !isNaN(tNew) &&
              !isNaN(tPrev) &&
              tNew < tPrev
            ) {
              map.set(key, r);
            }
          }
        }

        const unique = sortByDateAsc(
          Array.from(map.values()),
          "date"
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

      if (type === "finalize_order") {
        const sid = String(url.searchParams.get("sid") || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid");
        try {
          const order = await saveOrderFromSession({ id: sid });
          // IMPORTANT:
          // Do NOT send emails here. Webhook (checkout.session.completed)
          // is the single source of truth for receipts + chair emails.
          return REQ_OK(res, {
            ok: true,
            orderId: order.id,
            status: order.status || "paid",
          });
        } catch (err) {
          console.error("finalize_order failed:", err);
          return REQ_ERR(res, 500, "finalize-failed", {
            detail: String(err?.message || err),
          });
        }
      }

      if (type === "order") {
        const oid = String(url.searchParams.get("oid") || "").trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid");
        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found");
        return REQ_OK(res, { order });
      }

      return REQ_ERR(res, 400, "unknown-type");
    }

    // ---------- POST ----------
    if (req.method === "POST") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body || "{}")
          : req.body || {};

      // --- Quick manual Resend test (no auth) ---
      if (action === "test_resend") {
        if (!resend)
          return REQ_ERR(res, 500, "resend-not-configured");
        const urlObj = new URL(
          req.url,
          `http://${req.headers.host}`
        );
        const bodyTo = (body && body.to) || urlObj.searchParams.get("to") || "";
        const fallbackAdmin = (
          process.env.REPORTS_BCC || process.env.REPORTS_CC || ""
        )
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)[0] || "";
        const to = (bodyTo || fallbackAdmin).trim();
        if (!to) return REQ_ERR(res, 400, "missing-to");

        const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
          <h2>Resend test OK</h2>
          <p>Time: ${new Date().toISOString()}</p>
          <p>From: ${RESEND_FROM || ""}</p>
        </div>`;

        const payload = {
          from: RESEND_FROM || "onboarding@resend.dev",
          to: [to],
          subject: "Amaranth test email",
          html,
          reply_to: REPLY_TO || undefined,
        };

        const retry = await sendWithRetry(
          () => resend.emails.send(payload),
          "manual-test"
        );

        if (retry.ok) {
          const sendResult = retry.result;
          await recordMailLog({
            ts: Date.now(),
            from: RESEND_FROM || "onboarding@resend.dev",
            to: [to],
            subject: "Amaranth test email",
            resultId: sendResult?.id || null,
            kind: "manual-test",
            status: "queued",
          });
          return REQ_OK(res, {
            ok: true,
            id: sendResult?.id || null,
            to,
          });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: RESEND_FROM || "onboarding@resend.dev",
            to: [to],
            subject: "Amaranth test email",
            resultId: null,
            kind: "manual-test",
            status: "error",
            error: String(err?.message || err),
          });
          return REQ_ERR(res, 500, "resend-send-failed", {
            message: err?.message || String(err),
          });
        }
      }

      // --- NEW: Contact form (no auth) ---
      if (action === "contact_form") {
        if (!resend && !CONTACT_TO)
          return REQ_ERR(res, 500, "resend-not-configured");

        const {
          name = "",
          email = "",
          phone = "",
          topic = "",
          page = "",
          item = "",
          message: msg = "",
        } = body || {};

        const missing = [];
        if (!String(name).trim()) missing.push("name");
        if (!String(email).trim()) missing.push("email");
        if (!String(topic).trim()) missing.push("topic");
        if (!String(msg).trim()) missing.push("message");
        if (missing.length) {
          return REQ_ERR(res, 400, "missing-fields", { missing });
        }

        const topicMap = {
          banquets: "Banquets / meal choices",
          addons: "Grand Court add-ons (directory, love gifts, etc.)",
          catalog: "Product catalog / merchandise items",
          order: "Order / checkout issues",
          website: "Website or technical problem",
          general: "General question",
        };
        const pageMap = {
          home: "Home",
          banquet: "Banquets page",
          addons: "Grand Court Add-Ons page",
          catalog: "Product Catalog page",
          order: "Order page",
        };

        const topicLabel =
          topicMap[String(topic).toLowerCase()] ||
          String(topic) ||
          "General question";
        const pageLabel =
          pageMap[String(page).toLowerCase()] || String(page) || "";

        const esc = (s) => String(s ?? "").replace(/</g, "&lt;");
        const safe = (s) => String(s || "").trim();

        const createdIso = new Date().toISOString();
        const ua = req.headers["user-agent"] || "";
        const ip =
          req.headers["x-forwarded-for"] ||
          req.headers["x-real-ip"] ||
          req.socket?.remoteAddress ||
          "";

        const html = `
          <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
            <h2 style="margin-bottom:4px;">Website Contact Form</h2>
            <p style="margin:2px 0;">Time (UTC): ${esc(createdIso)}</p>
            <p style="margin:2px 0;">Topic: <b>${esc(topicLabel)}</b></p>
            ${
              pageLabel
                ? `<p style="margin:2px 0;">Page: <b>${esc(pageLabel)}</b></p>`
                : ""
            }
            <table style="border-collapse:collapse;border:1px solid #ccc;margin-top:10px;font-size:13px;">
              <tbody>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Name</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(name)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Email</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(email)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Phone</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(phone)}</td>
                </tr>
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Topic</th>
                  <td style="padding:4px 6px;border:1px solid #ddd;">${esc(topicLabel)}</td>
                </tr>
                ${
                  pageLabel
                    ? `<tr>
                        <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Page</th>
                        <td style="padding:4px 6px;border:1px solid #ddd;">${esc(
                          pageLabel
                        )}</td>
                      </tr>`
                    : ""
                }
                ${
                  item
                    ? `<tr>
                        <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Item</th>
                        <td style="padding:4px 6px;border:1px solid #ddd;">${esc(
                          item
                        )}</td>
                      </tr>`
                    : ""
                }
                <tr>
                  <th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;vertical-align:top;">Message</th>
                  <td style="padding:6px 8px;border:1px solid #ddd;white-space:pre-wrap;">${esc(
                    msg
                  )}</td>
                </tr>
              </tbody>
            </table>
            <p style="margin-top:10px;font-size:12px;color:#555;">
              Technical details: IP=${esc(ip)} · User-Agent=${esc(ua)}
            </p>
          </div>
        `;

        const { effective } = await getEffectiveSettings();
        const split = (val) =>
          String(val || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        const toList = [CONTACT_TO].filter(Boolean);
        const adminBccBase = split(
          effective.REPORTS_BCC ||
            effective.REPORTS_CC ||
            process.env.REPORTS_BCC ||
            process.env.REPORTS_CC ||
            ""
        );
        const senderEmail = safe(email).toLowerCase();
        const bccList = adminBccBase.filter(
          (addr) =>
            !toList.includes(addr) &&
            addr.toLowerCase() !== senderEmail
        );

        if (!toList.length && !bccList.length) {
          return REQ_ERR(res, 500, "no-recipient");
        }
        if (!resend) {
          return REQ_ERR(res, 500, "resend-not-configured");
        }

        const subject = `Website contact — ${topicLabel}`;

        const payload = {
          from: RESEND_FROM || "onboarding@resend.dev",
          to: toList.length ? toList : bccList,
          bcc: toList.length && bccList.length ? bccList : undefined,
          subject,
          html,
          reply_to: senderEmail || REPLY_TO || undefined,
        };

        const retry = await sendWithRetry(
          () => resend.emails.send(payload),
          "contact-form"
        );

        if (retry.ok) {
          const sendResult = retry.result;
          await recordMailLog({
            ts: Date.now(),
            from: RESEND_FROM || "onboarding@resend.dev",
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "queued",
            resultId: sendResult?.id || null,
          });

          return REQ_OK(res, { ok: true });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: RESEND_FROM || "onboarding@resend.dev",
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "error",
            error: String(err?.message || err),
          });
          return REQ_ERR(res, 500, "contact-send-failed", {
            message: err?.message || String(err),
          });
        }
      }

      // --- Finalize (save only) from success page ---
      // IMPORTANT: emails are sent from the Stripe webhook, not here.
      if (action === "finalize_checkout") {
        const stripe = await getStripe();
        if (!stripe)
          return REQ_ERR(res, 500, "stripe-not-configured");
        const sid = String(body.sid || body.id || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid");
        const order = await saveOrderFromSession({ id: sid });
        return REQ_OK(res, { ok: true, orderId: order.id });
      }

      // ---- PUBLIC: send chair-specific XLSX by category+item (no auth) ----
      if (action === "send_item_report") {
        const kind = String(
          body?.kind || body?.category || ""
        ).toLowerCase();
        const id = String(body?.id || "").trim();
        const label = String(body?.label || "").trim();
        const scope = String(body?.scope || "current-month");
        const result = await sendItemReportEmailInternal({
          kind,
          id,
          label,
          scope,
        });
        if (!result.ok)
          return REQ_ERR(
            res,
            500,
            result.error || "send-failed",
            result
          );
        return REQ_OK(res, { ok: true, ...result });
      }

      // ---- CREATE CHECKOUT (with BUNDLE PROTECTION + INTERNATIONAL FEE) ----
      if (action === "create_checkout_session") {
        const stripe = await getStripe();
        if (!stripe)
          return REQ_ERR(res, 500, "stripe-not-configured");

        const origin =
          req.headers.origin || `https://${req.headers.host}`;
        const successUrl =
          (body.success_url || `${origin}/success.html`) +
          `?sid={CHECKOUT_SESSION_ID}`;
        const cancelUrl =
          body.cancel_url || `${origin}/order.html`;

        if (Array.isArray(body.lines) && body.lines.length) {
          const lines = body.lines;
          const fees = body.fees || { pct: 0, flat: 0 };
          const purchaser = body.purchaser || {};

          const line_items = lines.map((l) => {
            const priceMode = (l.priceMode || "").toLowerCase();
            const isBundle =
              priceMode === "bundle" &&
              (l.bundleTotalCents ?? null) != null;

            const unit_amount = isBundle
              ? cents(l.bundleTotalCents)
              : toCentsAuto(l.unitPrice || 0);

            const quantity = isBundle
              ? 1
              : Math.max(1, Number(l.qty || 1));

            return {
              quantity,
              price_data: {
                currency: "usd",
                unit_amount,
                product_data: {
                  name: String(l.itemName || "Item"),
                  metadata: {
                    itemId: l.itemId || "",
                    itemType: l.itemType || "",
                    attendeeId: l.attendeeId || "",
                    attendeeName: l.meta?.attendeeName || "",
                    attendeeTitle: l.meta?.attendeeTitle || "",
                    attendeePhone: l.meta?.attendeePhone || "",
                    attendeeEmail: l.meta?.attendeeEmail || "",
                    attendeeNotes: l.meta?.attendeeNotes || "",
                    dietaryNote: l.meta?.dietaryNote || "",
                    itemNote: l.meta?.itemNote || "",
                    attendeeAddr1: l.meta?.attendeeAddr1 || "",
                    attendeeAddr2: l.meta?.attendeeAddr2 || "",
                    attendeeCity: l.meta?.attendeeCity || "",
                    attendeeState: l.meta?.attendeeState || "",
                    attendeePostal: l.meta?.attendeePostal || "",
                    attendeeCountry:
                      l.meta?.attendeeCountry || "",
                    priceMode: priceMode || "",
                    bundleQty: isBundle
                      ? String(l.bundleQty || "")
                      : "",
                    bundleTotalCents: isBundle
                      ? String(unit_amount)
                      : "",
                  },
                },
              },
            };
          });

          const pct = Number(fees.pct || 0);
          const flatCents = toCentsAuto(fees.flat || 0);

          // Subtotal of cart items (no fees yet)
          const subtotalCents = lines.reduce((s, l) => {
            const priceMode = (l.priceMode || "").toLowerCase();
            const isBundle =
              priceMode === "bundle" &&
              (l.bundleTotalCents ?? null) != null;
            if (isBundle) {
              return s + cents(l.bundleTotalCents || 0);
            } else {
              return (
                s +
                toCentsAuto(l.unitPrice || 0) *
                  Number(l.qty || 0)
              );
            }
          }, 0);

          // Base processing fee (your normal pct + flat)
          const feeAmount = Math.max(
            0,
            Math.round(subtotalCents * (pct / 100)) + flatCents
          );
          if (feeAmount > 0) {
            line_items.push({
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: feeAmount,
                product_data: { name: "Processing Fee" },
              },
            });
          }

          // --- NEW: International card processing fee (3%) ---
          const purchaserCountry = (
            purchaser.country ||
            purchaser.addressCountry ||
            ""
          )
            .trim()
            .toUpperCase() || "US";
          const accountCountry = (
            process.env.STRIPE_ACCOUNT_COUNTRY || "US"
          )
            .trim()
            .toUpperCase();

          let intlFeeAmount = 0;
          if (isInternationalOrder(purchaserCountry, accountCountry)) {
            intlFeeAmount = computeInternationalFeeCents(
              subtotalCents,
              0.03
            );
          }

          if (intlFeeAmount > 0) {
            const intlLine = buildInternationalFeeLineItem(
              intlFeeAmount,
              "usd"
            );
            if (intlLine) {
              // add minimal metadata so it can be identified in reports if needed
              intlLine.price_data.product_data.metadata = {
                ...(intlLine.price_data.product_data.metadata || {}),
                itemType: "other",
                itemId: "intl-fee",
              };
              line_items.push(intlLine);
            }
          }

          const session = await getStripe().then((stripe) =>
            stripe.checkout.sessions.create({
              mode: "payment",
              line_items,
              customer_email: purchaser.email || undefined,
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: {
                purchaser_name: purchaser.name || "",
                purchaser_email: purchaser.email || "",
                purchaser_phone: purchaser.phone || "",
                purchaser_title: purchaser.title || "",
                purchaser_addr1: purchaser.address1 || "",
                purchaser_addr2: purchaser.address2 || "",
                purchaser_city: purchaser.city || "",
                purchaser_state: purchaser.state || "",
                purchaser_postal: purchaser.postal || "",
                purchaser_country: purchaser.country || "",
                cart_count: String(lines.length || 0),
              },
            })
          );

          return REQ_OK(res, {
            url: session.url,
            id: session.id,
          });
        }

        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length)
          return REQ_ERR(res, 400, "no-items");

        const session = await getStripe().then((stripe) =>
          stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            line_items: items.map((it) => ({
              quantity: Math.max(1, Number(it.quantity || 1)),
              price_data: {
                currency: "usd",
                unit_amount: dollarsToCents(it.price || 0),
                product_data: { name: String(it.name || "Item") },
              },
            })),
            success_url: successUrl,
            cancel_url: cancelUrl,
          })
        );
        return REQ_OK(res, {
          url: session.url,
          id: session.id,
        });
      }

      if (action === "stripe_webhook") {
        const stripe = await getStripe();
        if (!stripe)
          return REQ_ERR(res, 500, "stripe-not-configured");

        let event;
        const sig = req.headers["stripe-signature"];
        const whsec = process.env.STRIPE_WEBHOOK_SECRET || "";

        try {
          if (whsec && typeof req.body === "string") {
            event = stripe.webhooks.constructEvent(
              req.body,
              sig,
              whsec
            );
          } else if (whsec && req.rawBody) {
            event = stripe.webhooks.constructEvent(
              req.rawBody,
              sig,
              whsec
            );
          } else {
            event =
              typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body;
          }
        } catch (err) {
          console.error(
            "Webhook signature verification failed:",
            err?.message
          );
          return REQ_ERR(res, 400, "invalid-signature");
        }

        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const order = await saveOrderFromSession(
              session.id || session
            );
            (async () => {
              try {
                await sendOrderReceipts(order);
                await maybeSendRealtimeChairEmails(order);
              } catch (err) {
                console.error(
                  "email-failed",
                  err?.message || err
                );
              }
            })();
            break;
          }
          case "charge.refunded": {
            const refund = event.data.object;
            await applyRefundToOrder(refund.charge, refund);
            break;
          }
          default:
            break;
        }

        return REQ_OK(res, { received: true });
      }

      if (action === "register_item") {
        const {
          id = "",
          name = "",
          chairEmails = [],
          publishStart = "",
          publishEnd = "",
        } = body || {};
        if (!id || !name)
          return REQ_ERR(res, 400, "id-and-name-required");

        const cfg = {
          id,
          name,
          chairEmails: (Array.isArray(chairEmails)
            ? chairEmails
            : String(chairEmails).split(","))
            .map((s) => String(s || "").trim())
            .filter(Boolean),
          publishStart,
          publishEnd,
          updatedAt: new Date().toISOString(),
        };

        const ok1 = await kvHsetSafe(`itemcfg:${id}`, cfg);
        const ok2 = await kvSaddSafe("itemcfg:index", id);
        if (!ok1 || !ok2)
          return REQ_OK(res, {
            ok: true,
            warning: "kv-unavailable",
          });

        return REQ_OK(res, { ok: true });
      }

      // -------- ADMIN (auth required below) --------
      if (!requireToken(req, res)) return;

      if (action === "send_full_report") {
        try {
          const mod = await import("./admin/send-full.js");
          const result = await mod.default();
          return REQ_OK(res, result || { ok: true });
        } catch (e) {
          return REQ_ERR(res, 500, "send-full-failed", {
            message: e?.message || String(e),
          });
        }
      }
      if (action === "send_month_to_date") {
        try {
          const mod = await import("./admin/send-month-to-date.js");
          const result = await mod.default();
          return REQ_OK(res, result || { ok: true });
        } catch (e) {
          return REQ_ERR(res, 500, "send-mtd-failed", {
            message: e?.message || String(e),
          });
        }
      }

      if (action === "send_monthly_chair_reports") {
        // Warm up orders cache once so the helper can reuse it
        await loadAllOrdersWithRetry();

        // Dynamically import the scheduler helper so a problem there
        // does NOT break normal /api/router traffic (addons, banquets, etc.)
        let schedulerMod;
        try {
          schedulerMod = await import("./admin/report-scheduler.js");
        } catch (e) {
          console.error("Failed to load ./admin/report-scheduler.js", e);
          return REQ_ERR(res, 500, "scheduler-missing", {
            message: e?.message || String(e),
          });
        }

        const { runScheduledChairReports } = schedulerMod || {};
        if (typeof runScheduledChairReports !== "function") {
          console.error("runScheduledChairReports is not a function");
          return REQ_ERR(res, 500, "scheduler-invalid");
        }

        // Delegate which items to send/skip to the helper
        const { sent, skipped, errors, itemsLog } =
          await runScheduledChairReports({
            now: new Date(),
            sendItemReportEmailInternal,
          });

        // Send a log email to admins (REPORTS_LOG_TO) summarizing all items,
        // including skipped ones and any errors.
        try {
          const logRecipients = REPORTS_LOG_TO.split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          if (resend && logRecipients.length) {
            const ts = new Date();
            const dateStr = ts.toISOString().slice(0, 10);
            const timeStr = ts.toISOString();

            const esc = (s) =>
              String(s || "").replace(/</g, "&lt;");

            const rowsHtml = (itemsLog || []).length
              ? itemsLog
                  .map((it, idx) => {
                    const status = it.skipped
                      ? "SKIPPED"
                      : it.ok
                        ? "OK"
                        : "ERROR";
                    const rowsLabel = it.skipped ? "-" : it.count;
                    const errorText = it.skipped
                      ? it.skipReason || ""
                      : it.error || "";

                    return `
              <tr>
                <td style="padding:4px;border:1px solid #ddd;">${idx + 1}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.id)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.label)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.kind)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(status)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${rowsLabel}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc((it.to || []).join(", "))}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc((it.bcc || []).join(", "))}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(errorText)}</td>
              </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="9" style="padding:6px;border:1px solid #ddd;">No items processed.</td></tr>`;

            const html = `
              <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
                <h2 style="margin-bottom:4px;">Scheduled Chair Reports Log</h2>
                <p style="margin:2px 0;">Time (UTC): ${esc(timeStr)}</p>
                <p style="margin:2px 0;">Scope: <b>current-month (per item frequency)</b></p>
                <p style="margin:6px 0 10px;">
                  Sent: <b>${sent}</b> &nbsp; | &nbsp;
                  Skipped: <b>${skipped}</b> &nbsp; | &nbsp;
                  Errors: <b>${errors}</b>
                </p>
                <table style="border-collapse:collapse;border:1px solid #ccc;font-size:13px;">
                  <thead>
                    <tr>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">#</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">ID</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Label</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Kind</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Status</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Rows</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">To</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">BCC</th>
                      <th style="padding:4px;border:1px solid #ddd;background:#f3f4f6;">Error / Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rowsHtml}
                  </tbody>
                </table>
              </div>
            `;

            const subject = `Scheduled chair report log — ${dateStr}`;

            const payload = {
              from: RESEND_FROM || "onboarding@resend.dev",
              to: logRecipients,
              subject,
              html,
              reply_to: REPLY_TO || undefined,
            };

            const retry = await sendWithRetry(
              () => resend.emails.send(payload),
              "monthly-log"
            );

            if (retry.ok) {
              const sendResult = retry.result;
              await recordMailLog({
                ts: Date.now(),
                from: payload.from,
                to: logRecipients,
                subject,
                resultId: sendResult?.id || null,
                kind: "monthly-log",
                status: "queued",
              });
            } else {
              const err = retry.error;
              await recordMailLog({
                ts: Date.now(),
                from: payload.from,
                to: logRecipients,
                subject,
                resultId: null,
                kind: "monthly-log",
                status: "error",
                error: String(err?.message || err),
              });
            }
          }
        } catch (e) {
          console.error("monthly_log_email_failed", e?.message || e);
        }

        return REQ_OK(res, {
          ok: true,
          sent,
          skipped,
          errors,
          scope: "current-month",
        });
      }

      if (action === "send_end_of_event_reports") {
        const now = Date.now();
        const ids = await kvSmembersSafe("itemcfg:index");
        let sent = 0,
          skipped = 0,
          errors = 0;

        for (const itemId of ids) {
          const cfg = await kvHgetallSafe(`itemcfg:${itemId}`);
          const publishEnd = cfg?.publishEnd
            ? Date.parse(cfg.publishEnd)
            : NaN;
          if (isNaN(publishEnd) || publishEnd > now) {
            skipped += 1;
            continue;
          }

          const already = await kvGetSafe(
            `itemcfg:${itemId}:end_sent`,
            false
          );
          if (already) {
            skipped += 1;
            continue;
          }

          const kind =
            String(cfg?.kind || "").toLowerCase() ||
            (itemId.includes("addon") ? "addon" : "banquet");
          const label = cfg?.name || itemId;

          const result = await sendItemReportEmailInternal({
            kind,
            id: itemId,
            label,
            scope: "full",
          });
          if (result.ok) {
            await kvSetSafe(
              `itemcfg:${itemId}:end_sent`,
              new Date().toISOString()
            );
            sent += 1;
          } else {
            errors += 1;
          }
        }
        return REQ_OK(res, {
          ok: true,
          sent,
          skipped,
          errors,
          scope: "full",
        });
      }

      if (action === "clear_orders") {
        await kvDelSafe("orders:index");
        return REQ_OK(res, {
          ok: true,
          message: "orders index cleared",
        });
      }

      if (action === "create_refund") {
        const stripe = await getStripe();
        if (!stripe)
          return REQ_ERR(res, 500, "stripe-not-configured");
        const payment_intent = String(
          body.payment_intent || ""
        ).trim();
        const charge = String(body.charge || "").trim();
        const amount_cents_raw = body.amount_cents;
        const args = {};
        if (amount_cents_raw != null)
          args.amount = cents(amount_cents_raw);
        if (payment_intent) args.payment_intent = payment_intent;
        else if (charge) args.charge = charge;
        else
          return REQ_ERR(
            res,
            400,
            "missing-payment_intent-or-charge"
          );

        const rf = await stripe.refunds.create(args);
        try {
          await applyRefundToOrder(rf.charge, rf);
        } catch {}
        return REQ_OK(res, {
          ok: true,
          id: rf.id,
          status: rf.status,
        });
      }

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets)
          ? body.banquets
          : [];
        await kvSetSafe("banquets", list);

        try {
          if (Array.isArray(list)) {
            for (const b of list) {
              const id = String(b?.id || "");
              if (!id) continue;
              const name = String(b?.name || "");
              const chairEmails = Array.isArray(b?.chairEmails)
                ? b.chairEmails
                : String(
                    b?.chairEmails || b?.chair?.email || ""
                  )
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
              const cfg = {
                id,
                name,
                kind: "banquet",
                chairEmails,
                publishStart: b?.publishStart || "",
                publishEnd: b?.publishEnd || "",
                updatedAt: new Date().toISOString(),
              };
              await kvHsetSafe(`itemcfg:${id}`, cfg);
              await kvSaddSafe("itemcfg:index", id);
            }
          }
        } catch {}

        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_addons") {
        const list = Array.isArray(body.addons)
          ? body.addons
          : [];
        await kvSetSafe("addons", list);

        try {
          if (Array.isArray(list)) {
            for (const a of list) {
              const id = String(a?.id || "");
              if (!id) continue;
              const name = String(a?.name || "");
              const chairEmails = Array.isArray(a?.chairEmails)
                ? a.chairEmails
                : String(
                    a?.chairEmails || a?.chair?.email || ""
                  )
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
              const cfg = {
                id,
                name,
                kind: "addon",
                chairEmails,
                publishStart: a?.publishStart || "",
                publishEnd: a?.publishEnd || "",
                updatedAt: new Date().toISOString(),
              };
              await kvHsetSafe(`itemcfg:${id}`, cfg);
              await kvSaddSafe("itemcfg:index", id);
            }
          }
        } catch {}

        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_products") {
        const list = Array.isArray(body.products)
          ? body.products
          : [];
        await kvSetSafe("products", list);

        try {
          if (Array.isArray(list)) {
            for (const p of list) {
              const id = String(p?.id || "");
              if (!id) continue;
              const name = String(p?.name || "");
              const chairEmails = Array.isArray(p?.chairEmails)
                ? p.chairEmails
                : String(
                    p?.chairEmails || p?.chair?.email || ""
                  )
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);

              const cfg = {
                id,
                name,
                kind: "catalog",
                chairEmails,
                publishStart: p?.publishStart || "",
                publishEnd: p?.publishEnd || "",
                updatedAt: new Date().toISOString(),
              };
              await kvHsetSafe(`itemcfg:${id}`, cfg);
              await kvSaddSafe("itemcfg:index", id);
            }
          }
        } catch {}

        return REQ_OK(res, { ok: true, count: list.length });
      }

      if (action === "save_settings") {
        const allow = {};
        [
          "RESEND_FROM",
          "REPORTS_CC",
          "REPORTS_BCC",
          "SITE_BASE_URL",
          "MAINTENANCE_ON",
          "MAINTENANCE_MESSAGE",
          "REPORTS_SEND_SEPARATE",
          "REPLY_TO",
          "EVENT_START",
          "EVENT_END",
          "REPORT_ORDER_DAYS",
        ].forEach((k) => {
          if (k in body) allow[k] = body[k];
        });

        if ("MAINTENANCE_ON" in allow) {
          allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
        }

        if (Object.keys(allow).length) {
          await kvHsetSafe("settings:overrides", allow);
        }
        return REQ_OK(res, {
          ok: true,
          overrides: allow,
        });
      }

      return REQ_ERR(res, 400, "unknown-action");
    }

    return REQ_ERR(res, 405, "method-not-allowed");
  } catch (e) {
    console.error(e);
    return REQ_ERR(res, 500, "router-failed", {
      message: e?.message || e,
    });
  }
}

// Vercel Node 22 runtime
export const config = { runtime: "nodejs" };
