// /api/router.js
import crypto from "crypto";

import {
  kv,
  getStripe,
  getStripePublishableKey,
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
  normalizeReportFrequency,
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
  // checkout mode helpers + purge
  getCheckoutSettingsRaw,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
  purgeOrdersByMode,

  // ✅ Receipts ZIP helpers
  emailMonthlyReceiptsZip,
  emailFinalReceiptsZip,
} from "./admin/core.js";

import {
  isInternationalOrder,
  computeInternationalFeeCents,
  buildInternationalFeeLineItem,
} from "./admin/fees.js";

import { handleAdminLogin, verifyAdminToken } from "./admin/security.js";

// Year-over-year helpers (orders / purchasers / people / amount)
import {
  listIndexedYears,
  getYearSummary,
  getMultiYearSummary,
} from "./admin/yearly-reports.js";

// scheduler + debug helpers
import {
  debugScheduleForItem,
  handleSmoketest,
  handleLastMail,
  handleTokenTest,
  handleStripeTest,
  handleResendTest,
  handleSchedulerDiagnostic,
  handleOrdersHealth,
  handleItemcfgHealth,
  handleSchedulerDryRun,
  handleChairPreview,
  handleOrderPreview,
  handleWebhookPreview,
} from "../admin/debug.js";

// ============================================================================
// BETTER ERROR DETAILS (safe for end-users)
// ============================================================================
function getRequestId(req) {
  return (
    req?.headers?.["x-vercel-id"] ||
    req?.headers?.["x-request-id"] ||
    `local-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );
}

function toSafeError(err) {
  const e = err || {};
  const name = String(e.name || "Error");
  const message = String(e.message || e.toString?.() || "Unknown error");

  const stripe = {};
  if (e.type) stripe.type = String(e.type);
  if (e.code) stripe.code = String(e.code);
  if (e.param) stripe.param = String(e.param);
  if (e.decline_code) stripe.decline_code = String(e.decline_code);
  if (e.statusCode || e.status_code)
    stripe.status = Number(e.statusCode || e.status_code);

  const safe = {
    name,
    message,
    stackTop: typeof e.stack === "string" ? e.stack.split("\n")[0] : "",
  };

  if (Object.keys(stripe).length) safe.stripe = stripe;
  return safe;
}

function errResponse(res, status, code, req, err, extra = {}) {
  const requestId = getRequestId(req);
  const safe = toSafeError(err);
  console.error(`[router] ${code} requestId=${requestId}`, err);
  return REQ_ERR(res, status, code, {
    requestId,
    error: safe,
    ...extra,
  });
}

// ===============================================================if (type === "orders_csv") {
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

        
        // Build XLSX safely (no null rows; ExcelJS-friendly primitives)
        rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];

        const sortedRaw = sortByDateAsc(rows, "date");
        const sorted = Array.isArray(sortedRaw)
          ? sortedRaw.filter((r) => r && typeof r === "object")
          : [];

        const fallbackRow = {
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

        const safeVal = (v) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "bigint") return v.toString();
          if (Array.isArray(v)) return v.map((x) => (x == null ? "" : String(x))).join(", ");
          if (typeof v === "object") {
            try { return JSON.stringify(v); } catch { return String(v); }
          }
          return v;
        };

        const headers = Object.keys(sorted[0] || fallbackRow);
        const rowsForXlsx = (sorted.length ? sorted : [fallbackRow]).map((r) => {
          const out = {};
          for (const h of headers) out[h] = safeVal(r && typeof r === "object" ? r[h] : "");
          return out;
        });

        const buf = await objectsToXlsxBuffer(headers, rowsForXlsx, null, "Orders");

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="orders.xlsx"`);
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

        const buf = await objectsToXlsxBuffer(headers, sorted, null, "Directory");
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

      // ✅ finalize_order now writes hash markers + sends receipts + realtime chair emails immediately
      if (type === "finalize_order") {
        const sid = String(url.searchParams.get("sid") || "").trim();
        if (!sid) return REQ_ERR(res, 400, "missing-sid", { requestId });

        try {
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");
          const order = await saveOrderFromSession(
            { id: sid },
            { mode: orderChannel }
          );

          // ✅ write-once createdAt + hash (tamper detection)
          await ensureOrderIntegrityMarkers(order, requestId);

          // 🔥 Immediate: buyer receipts + chair emails + admin copy
          await sendPostOrderEmails(order, requestId);

          return REQ_OK(res, {
            requestId,
            ok: true,
            orderId: order.id,
            status: order.status || "paid",
          });
        } catch (err) {
          return errResponse(res, 500, "finalize-failed", req, err, { sid });
        }
      }

      if (type === "order") {
        const oid = String(url.searchParams.get("oid") || "").trim();
        if (!oid) return REQ_ERR(res, 400, "missing-oid", { requestId });
        const order = await kvGetSafe(`order:${oid}`, null);
        if (!order) return REQ_ERR(res, 404, "order-not-found", { requestId });
        return REQ_OK(res, { requestId, order });
      }

      
      // ✅ HTML receipt (same formatter as the emailed receipt) — for success.html
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

// --------------------------------------------------------------------
      // ✅ Compatibility: allow GET /api/router?type=send_item_report&... for testing
      // - If dryRun=1, returns a preview (no email sent) and does NOT require auth.
      // - If dryRun is falsey, requires admin auth and will send the email.
      // --------------------------------------------------------------------
      if (type === "send_item_report") {
        const kind = String(url.searchParams.get("kind") || "").trim().toLowerCase();
        const id = String(url.searchParams.get("id") || "").trim();
        const label = String(url.searchParams.get("label") || "").trim();
        const scope = String(url.searchParams.get("scope") || "current-month").trim();
        const dryRun = coerceBool(url.searchParams.get("dryRun") || url.searchParams.get("dry_run") || "");

        if (!id) return REQ_ERR(res, 400, "missing-id", { requestId });

        // Dry-run: provide a safe preview (no email)
        if (dryRun) {
          try {
            // We reuse the existing preview helper. It uses itemcfg + orders to show
            // what *would* be sent, without sending anything.
            const out = await handleChairPreview({ id, scope });
            return REQ_OK(res, {
              requestId,
              ok: true,
              dryRun: true,
              kind: kind || (out?.kind || ""),
              id,
              label: label || out?.label || out?.name || "",
              scope,
              preview: out,
            });
          } catch (e) {
            return errResponse(res, 500, "send-item-report-dryrun-failed", req, e, {
              id,
              scope,
            });
          }
        }

        // Real send: admin-only + respects lockdown
        if (!(await requireAdminAuth(req, res))) return;
        if (!(await enforceLockdownIfNeeded(req, res, "send_item_report", requestId))) return;

        try {
          const result = await sendItemReportEmailInternal({ kind, id, label, scope });
          if (!result?.ok) {
            return REQ_ERR(res, 500, result?.error || "send-failed", {
              requestId,
              ...(result || {}),
            });
          }
          return REQ_OK(res, { requestId, ok: true, ...result });
        } catch (e) {
          return errResponse(res, 500, "send-item-report-failed", req, e, { kind, id, scope });
        }
      }

            // ================= VISITS: TOP PAGES (ADMIN) =================
      // Returns top pages over the last N days (default 30).
      // Requires admin auth.
      if (type === "visits_pages") {
        if (!(await requireAdminAuth(req, res))) return;

        const mode = String(q.mode || "auto");
        const days = Math.max(1, Math.min(365, parseInt(q.days || "30", 10) || 30));
        const limit = Math.max(1, Math.min(200, parseInt(q.limit || "50", 10) || 50));

        const effectiveMode =
          mode === "auto"
            ? await getEffectiveOrderChannel().catch(() => "test")
            : String(mode || "test").toLowerCase();

        if (effectiveMode !== "test" && effectiveMode !== "live_test" && effectiveMode !== "live") {
          return REQ_ERR(res, 400, "invalid-mode", { requestId, mode });
        }

        const base = `visits:${effectiveMode}`;
        const pages = (await kvSmembersSafe(`${base}:pages`)) || [];
        const results = [];

        for (const page of pages) {
          const pagePath = normalizeVisitPath(page);

          let total = 0;

          for (let i = 0; i < days; i++) {
            const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            const k = `${base}:day:${d}:path:${encodeURIComponent(pagePath)}`;
            total += Number(await kvGetSafe(k, 0)) || 0;
          }

          if (total > 0) results.push({ page: pagePath, total });
        }

        results.sort((a, b) => b.total - a.total);
        return REQ_OK(res, {
          requestId,
          ok: true,
          mode: effectiveMode,
          days,
          pages: results.slice(0, limit),
        });
      }

return REQ_ERR(res, 400, "unknown-type", { requestId });
    }

    // ---------- POST ----------
    if (req.method === "POST") {
      let body = {};
      try {
        if (action !== "stripe_webhook") {
          body = await readJsonBody(req);
        }
      } catch (e) {
        return errResponse(res, 400, "invalid-json", req, e);
      }


      // ✅ Public: track a visit (no auth)
      if (action === "track_visit") {
        try {
          const pathParam =
            String(body?.path || body?.pathname || "") ||
            String(url.searchParams.get("path") || url.searchParams.get("p") || "");
          const fallbackPath = url.pathname || "/";
          const mode = await getEffectiveOrderChannel().catch(() => "test");
          const out = await trackVisitInternal({
            path: pathParam || fallbackPath,
            mode,
            now: new Date(),
          });
          return REQ_OK(res, { requestId, ...out });
        } catch (e) {
          return errResponse(res, 500, "track-visit-failed", req, e);
        }
      }

      if (action === "admin_login") {
        try {
          const ip =
            req.headers["x-forwarded-for"] ||
            req.headers["x-real-ip"] ||
            req.socket?.remoteAddress ||
            "";
          const ua = req.headers["user-agent"] || "";

          console.log("[router] admin_login called", { ip, ua, hasBody: !!body });

          const result = await handleAdminLogin({
            password: String(body.password || ""),
            ip,
            userAgent: ua,
          });

          console.log("[router] admin_login result", result);

          if (result.ok) return REQ_OK(res, { requestId, ...result });

          const status =
            result.error === "invalid_password" || result.error === "locked_out"
              ? 401
              : 500;

          const errCode = result.error || "login-failed";
          return REQ_ERR(res, status, errCode, { requestId, ...result });
        } catch (e) {
          return errResponse(res, 500, "login-failed", req, e);
        }
      }

      if (action === "test_resend") {
        if (!resend)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });
        const urlObj = getUrl(req);
        const bodyTo = (body && body.to) || urlObj.searchParams.get("to") || "";
        const fallbackAdmin =
          (process.env.REPORTS_BCC || process.env.REPORTS_CC || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)[0] || "";
        const to = (bodyTo || fallbackAdmin).trim();
        if (!to) return REQ_ERR(res, 400, "missing-to", { requestId });

        const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
          <h2>Resend test OK</h2>
          <p>Time: ${new Date().toISOString()}</p>
          <p>From: ${RESEND_FROM || ""}</p>
          <p>requestId: ${String(requestId).replace(/</g, "&lt;")}</p>
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
            from: payload.from,
            to: [to],
            subject: payload.subject,
            resultId: sendResult?.id || null,
            kind: "manual-test",
            status: "queued",
          });
          return REQ_OK(res, {
            requestId,
            ok: true,
            id: sendResult?.id || null,
            to,
          });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [to],
            subject: payload.subject,
            resultId: null,
            kind: "manual-test",
            status: "error",
            error: String(err?.message || err),
          });
          return errResponse(res, 500, "resend-send-failed", req, err);
        }
      }

      if (action === "contact_form") {
        if (!resend && !CONTACT_TO)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });

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
        if (missing.length)
          return REQ_ERR(res, 400, "missing-fields", { requestId, missing });

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
        const pageLabel = pageMap[String(page).toLowerCase()] || String(page) || "";

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
            ${pageLabel ? `<p style="margin:2px 0;">Page: <b>${esc(pageLabel)}</b></p>` : ""}
            <p style="margin:2px 0;font-size:12px;color:#555;">requestId: ${esc(
              requestId
            )}</p>
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
                ${pageLabel ? `<tr><th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Page</th><td style="padding:4px 6px;border:1px solid #ddd;">${esc(pageLabel)}</td></tr>` : ""}
                ${item ? `<tr><th style="padding:4px 6px;border:1px solid #ddd;background:#f3f4f6;text-align:left;">Item</th><td style="padding:4px 6px;border:1px solid #ddd;">${esc(item)}</td></tr>` : ""}
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
          (addr) => !toList.includes(addr) && addr.toLowerCase() !== senderEmail
        );

        if (!toList.length && !bccList.length)
          return REQ_ERR(res, 500, "no-recipient", { requestId });
        if (!resend)
          return REQ_ERR(res, 500, "resend-not-configured", { requestId });

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
            from: payload.from,
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "queued",
            resultId: sendResult?.id || null,
          });
          return REQ_OK(res, { requestId, ok: true });
        } else {
          const err = retry.error;
          await recordMailLog({
            ts: Date.now(),
            from: payload.from,
            to: [...toList, ...bccList],
            subject,
            kind: "contact-form",
            status: "error",
            error: String(err?.message || err),
          });
          return errResponse(res, 500, "contact-send-failed", req, err);
        }
      }

      // ✅ finalize_checkout now writes hash markers + sends receipts + realtime chair emails immediately
      if (action === "finalize_checkout") {
        try {
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");

          // ✅ FIX: use the correct Stripe client for the current order channel
          const stripe = await getStripe(orderChannel);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          const sid = String(body.sid || body.id || "").trim();
          if (!sid) return REQ_ERR(res, 400, "missing-sid", { requestId });

          const order = await saveOrderFromSession({ id: sid }, { mode: orderChannel });

          // ✅ write-once createdAt + hash (tamper detection)
          await ensureOrderIntegrityMarkers(order, requestId);

          // 🔥 Immediate: buyer receipts + chair emails + admin copy
          await sendPostOrderEmails(order, requestId);

          return REQ_OK(res, { requestId, ok: true, orderId: order.id });
        } catch (e) {
          return errResponse(res, 500, "finalize-checkout-failed", req, e);
        }
      }

      if (action === "send_item_report") {
        try {
          const kind = String(body?.kind || body?.category || "").toLowerCase();
          const id = String(body?.id || "").trim();
          const label = String(body?.label || "").trim();
          const scope = String(body?.scope || "current-month");
          const result = await sendItemReportEmailInternal({ kind, id, label, scope });
          if (!result.ok)
            return REQ_ERR(res, 500, result.error || "send-failed", {
              requestId,
              ...result,
            });
          return REQ_OK(res, { requestId, ok: true, ...result });
        } catch (e) {
          return errResponse(res, 500, "send-item-report-failed", req, e);
        }
      }

      if (action === "create_checkout_session") {
        try {
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");

          const stripe = await getStripe(orderChannel);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          const origin = req.headers.origin || `https://${req.headers.host}`;
          const successUrl =
            (body.success_url || `${origin}/success.html`) +
            `?sid={CHECKOUT_SESSION_ID}`;
          const cancelUrl = body.cancel_url || `${origin}/order.html`;

          if (Array.isArray(body.lines) && body.lines.length) {
            const lines = body.lines;
            const fees = body.fees || { pct: 0, flat: 0 };
            const purchaser = body.purchaser || {};

            const line_items = lines.map((l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle =
                priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;

              const unit_amount = isBundle
                ? cents(l.bundleTotalCents)
                : toCentsAuto(l.unitPrice || 0);
              const quantity = isBundle ? 1 : Math.max(1, Number(l.qty || 1));

              // ✅ Love Gift / variable donation: include per-person amount in the item name
              // so chair/realtime emails that only show itemName still include the dollar amount.
              let displayName = String(l.itemName || "Item");
              try {
                const id = String(l.itemId || "").trim().toLowerCase();
                const t = String(l.itemType || "").trim().toLowerCase();
                const looksLikeLoveGift =
                  id === "love_gift" ||
                  id === "lovegift" ||
                  id.includes("love_gift") ||
                  id.includes("lovegift") ||
                  (t === "addon" && displayName.toLowerCase().includes("love gift")) ||
                  displayName.toLowerCase().includes("love gift");
                if (looksLikeLoveGift && Number.isFinite(unit_amount)) {
                  const amt = (Number(unit_amount) / 100).toFixed(2);
                  // Avoid double-appending if already present
                  if (!displayName.includes("$")) displayName = `${displayName} — $${amt}`;
                }
              } catch {}
              // ✅ Corsage variants: keep separate line items & show choice/note on Order page + receipts
              // We DO NOT change itemId (so chair email routing still works), but we make the Stripe product
              // name unique per variant so your UI can show "Rose Corsage" vs "Custom Corsage — note..."
              try {
                const id2 = String(l.itemId || "").trim().toLowerCase();
                const name2 = String(displayName || "").toLowerCase();
                const looksLikeCorsage =
                  id2 === "corsage" ||
                  id2 === "corsages" ||
                  id2.includes("corsage") ||
                  name2.includes("corsage");

                if (looksLikeCorsage) {
                  const choice =
                    String(
                      l?.meta?.corsageChoice ??
                        l?.meta?.corsage_choice ??
                        l?.meta?.corsageType ??
                        l?.meta?.corsage_type ??
                        l?.meta?.choice ??
                        l?.meta?.selection ??
                        l?.meta?.style ??
                        l?.meta?.color ??
                        ""
                    ).trim();

                  const wearRaw =
                    String(
                      l?.meta?.corsageWear ??
                        l?.meta?.corsage_wear ??
                        l?.meta?.wear ??
                        l?.meta?.wearStyle ??
                        l?.meta?.wear_style ??
                        l?.meta?.attachment ??
                        ""
                    ).trim();
                  const wearLower = wearRaw.toLowerCase();
                  const wearLabel =
                    wearLower === "wrist" || wearLower === "w"
                      ? "Wrist"
                      : wearLower === "pin" ||
                        wearLower === "pin-on" ||
                        wearLower === "pin on" ||
                        wearLower === "p"
                      ? "Pin-on"
                      : wearRaw;

                  const noteRaw =
                    String(
                      l?.meta?.itemNote ||
                        l?.meta?.item_note ||
                        l?.meta?.notes ||
                        l?.meta?.note ||
                        l?.meta?.message ||
                        l?.itemNote ||
                        l?.item_note ||
                        l?.notes ||
                        l?.note ||
                        l?.message ||
                        ""
                    ).trim();

                  if (choice) {
                    const lowerChoice = choice.toLowerCase();
                    // Avoid double-appending
                    if (!name2.includes(lowerChoice)) displayName = `${displayName} (${choice})`;
                  }

                  
                  if (wearLabel) {
                    const wl = String(wearLabel).toLowerCase();
                    // Avoid double-appending
                    if (!String(displayName).toLowerCase().includes(wl)) {
                      // If we already added choice as "(...)", prefer "(Choice, Wear)"
                      const m = String(displayName).match(/^(.*)\(([^)]*)\)\s*$/);
                      if (m && m[2] && !m[2].toLowerCase().includes(wl)) {
                        displayName = `${m[1]}(${m[2]}, ${wearLabel})`;
                      } else {
                        displayName = `${displayName} (${wearLabel})`;
                      }
                    }
                  }
// If it's custom, or they typed a note, include it in the displayed name (trimmed)
                  if (noteRaw) {
                    const shortNote = noteRaw.length > 90 ? noteRaw.slice(0, 87) + "…" : noteRaw;
                    if (!String(displayName).includes(shortNote)) displayName = `${displayName} — ${shortNote}`;
                  }
                }
              
                // Pre-Registration: include Voting / Non-Voting in the item name so it shows up in
                // - Stripe customer email receipts
                // - Our emailed receipt / success.html receipt
                // - Chair spreadsheets (deriveVotingStatus reads stored text)
                try {
                  const votingBool =
                    l?.meta?.isVoting ??
                    l?.meta?.votingBool ??
                    l?.meta?.voting_boolean ??
                    null;

                  const votingRaw =
                    l?.meta?.votingStatus ??
                    l?.meta?.voting_status ??
                    l?.meta?.voting ??
                    l?.meta?.votingType ??
                    l?.meta?.voting_type ??
                    l?.meta?.votingFlag ??
                    l?.meta?.voting_flag ??
                    "";

                  let votingLabel = "";
                  if (votingBool === true) votingLabel = "Voting";
                  else if (votingBool === false) votingLabel = "Non-Voting";
                  else {
                    const vr = String(votingRaw ?? "").trim().toLowerCase();
                    if (vr) {
                      if (/non\s*-?\s*voting/.test(vr) || /nonvoting/.test(vr) || vr === "nv") votingLabel = "Non-Voting";
                      else if (/\bvoting\b/.test(vr) || vr === "v") votingLabel = "Voting";
                      else if (["1", "true", "t", "yes", "y"].includes(vr)) votingLabel = "Voting";
                      else if (["0", "false", "f", "no", "n"].includes(vr)) votingLabel = "Non-Voting";
                    }
                  }

                  const isPreReg =
                    (id2.includes("pre") && (id2.includes("reg") || id2.includes("registration"))) ||
                    name2.includes("pre-registration") ||
                    name2.includes("pre registration") ||
                    name2.includes("pre reg") ||
                    name2.includes("prereg");

// Fallback: if the Order page already embedded "Voting"/"Non-Voting" in attendeeTitle/notes,
// reuse that for Stripe-visible names (Stripe does not display metadata on receipts).
if (isPreReg && !votingLabel) {
  const fromTitle = String(l?.meta?.attendeeTitle || "").toLowerCase();
  const fromNotes = String(l?.meta?.attendeeNotes || l?.meta?.attendeeNote || "").toLowerCase();
  const fromName  = String(displayName || "").toLowerCase();
  const blob = `${fromTitle} ${fromNotes} ${fromName}`.trim();
  if (blob) {
    if (blob.includes("non-voting") || blob.includes("nonvoting") || blob.includes("non voting") || /nv/.test(blob)) votingLabel = "Non-Voting";
    else if (blob.includes("voting") || /v/.test(blob)) votingLabel = "Voting";
  }
}


                  if (isPreReg && votingLabel) {
                    const dl = String(displayName || "").toLowerCase();
                    // Avoid double-appending
                    if (!dl.includes("non-voting") && !dl.includes("nonvoting") && !dl.includes("voting")) {
                      displayName = `${displayName} (${votingLabel})`;
                    }

                    // Also ensure it shows up like banquet notes in our receipt:
                    // put it into itemNote if no other notes exist.
                    try {
                      l.meta = l.meta || {};
                      const hasNotes =
                        !!(l.meta.itemNote || l.meta.item_note || l.meta.attendeeNotes || l.meta.dietaryNote);
                      if (!hasNotes) {
                        l.meta.itemNote = `Member: ${votingLabel}`;
                      }
                    } catch {}
                  }
                } catch {}
} catch {}


              return {
                quantity,
                price_data: {
                  currency: "usd",
                  unit_amount,
                  product_data: {
                    name: displayName,
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
                      votingStatus:
                        (l.meta?.votingStatus ||
                          l.meta?.voting_status ||
                          l.meta?.voting ||
                          l.meta?.votingType ||
                          l.meta?.voting_type ||
                          ""),
                      voting_status:
                        (l.meta?.votingStatus ||
                          l.meta?.voting_status ||
                          l.meta?.voting ||
                          l.meta?.votingType ||
                          l.meta?.voting_type ||
                          ""),
                      isVoting:
                        String(
                          l.meta?.isVoting ??
                            l.meta?.votingBool ??
                            l.meta?.voting_boolean ??
                            ""
                        ),

                      itemNote:
                        (l.meta?.itemNote ||
                          l.meta?.item_note ||
                          l.meta?.notes ||
                          l.meta?.note ||
                          l.meta?.message ||
                          l.itemNote ||
                          l.item_note ||
                          l.notes ||
                          l.note ||
                          l.message ||
                          "")
                        ,
                      corsageChoice:
                        (l.meta?.corsageChoice ||
                          l.meta?.corsage_choice ||
                          l.meta?.corsageType ||
                          l.meta?.corsage_type ||
                          l.meta?.choice ||
                          l.meta?.selection ||
                          l.meta?.style ||
                          l.meta?.color ||
                          ""),
                                            corsageWear:
                        (l.meta?.corsageWear ||
                          l.meta?.corsage_wear ||
                          l.meta?.wear ||
                          l.meta?.wearStyle ||
                          l.meta?.wear_style ||
                          l.meta?.attachment ||
                          ""),
corsageNote:
                        (l.meta?.itemNote ||
                          l.meta?.item_note ||
                          l.meta?.notes ||
                          l.meta?.note ||
                          l.meta?.message ||
                          l.itemNote ||
                          l.item_note ||
                          l.notes ||
                          l.note ||
                          l.message ||
                          ""),

                      attendeeAddr1: l.meta?.attendeeAddr1 || "",
                      attendeeAddr2: l.meta?.attendeeAddr2 || "",
                      attendeeCity: l.meta?.attendeeCity || "",
                      attendeeState: l.meta?.attendeeState || "",
                      attendeePostal: l.meta?.attendeePostal || "",
                      attendeeCountry: l.meta?.attendeeCountry || "",
                      priceMode: priceMode || "",
                      bundleQty: isBundle ? String(l.bundleQty || "") : "",
                      bundleTotalCents: isBundle ? String(unit_amount) : "",
                      loveGiftAmountCents: String(unit_amount),
                    },
                  },
                },
              };
            });

            const pct = Number(fees.pct || 0);
            const flatCents = toCentsAuto(fees.flat || 0);

            const subtotalCents = lines.reduce((s, l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle =
                priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;
              if (isBundle) return s + cents(l.bundleTotalCents || 0);
              return s + toCentsAuto(l.unitPrice || 0) * Number(l.qty || 0);
            }, 0);

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
                  product_data: {
                    name: "Online Processing Fee",
                    metadata: { itemType: "fee", itemId: "processing-fee" },
                  },
                },
              });
            }

            const purchaserCountry = String(
              purchaser.country || purchaser.addressCountry || "US"
            )
              .trim()
              .toUpperCase();
            const accountCountry = String(process.env.STRIPE_ACCOUNT_COUNTRY || "US")
              .trim()
              .toUpperCase();

            let intlFeeAmount = 0;
            if (isInternationalOrder(purchaserCountry, accountCountry)) {
              intlFeeAmount = computeInternationalFeeCents(subtotalCents, 0.03);
            }

            if (intlFeeAmount > 0) {
              const intlLine = buildInternationalFeeLineItem(intlFeeAmount, "usd");
              if (intlLine && intlLine.price_data?.product_data) {
                intlLine.price_data.product_data.name =
                  intlLine.price_data.product_data.name ||
                  "International Card Processing Fee (3%)";
                intlLine.price_data.product_data.metadata = {
                  ...(intlLine.price_data.product_data.metadata || {}),
                  itemType: "fee",
                  itemId: "intl-fee",
                };
                line_items.push(intlLine);
              } else if (intlLine) {
                line_items.push(intlLine);
              }
            }

            const session = await stripe.checkout.sessions.create({
              mode: "payment",
              line_items,
              customer_email: purchaser.email || undefined,
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: {
                order_channel: orderChannel,
                order_mode: orderChannel,
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
            });

            return REQ_OK(res, {
              requestId,
              url: session.url,
              id: session.id,
              mode: orderChannel,
            });
          }

          const items = Array.isArray(body.items) ? body.items : [];
          if (!items.length) return REQ_ERR(res, 400, "no-items", { requestId });

          const session = await stripe.checkout.sessions.create({
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
            metadata: { order_channel: orderChannel, order_mode: orderChannel },
          });

          return REQ_OK(res, {
            requestId,
            url: session.url,
            id: session.id,
            mode: orderChannel,
          });
        } catch (e) {
          return errResponse(res, 500, "checkout-create-failed", req, e, {
            hint:
              "If this only fails in live-test/live, it usually means STRIPE_SECRET_KEY_LIVE or webhook secret is missing/mismatched in that environment.",
          });
        }
      }

      if (action === "stripe_webhook") {
        try {
          const sig = req.headers["stripe-signature"];
          if (!sig) return REQ_ERR(res, 400, "missing-signature", { requestId });

          const whsecLive = (process.env.STRIPE_WEBHOOK_SECRET_LIVE || "").trim();
          const whsecTest = (process.env.STRIPE_WEBHOOK_SECRET_TEST || "").trim();
          const whsecFallback = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

          const trySecrets = [whsecLive, whsecTest, whsecFallback].filter(Boolean);
          if (!trySecrets.length) {
            console.error("[webhook] no webhook secrets configured");
            return REQ_ERR(res, 500, "missing-webhook-secret", { requestId });
          }

          const raw = await readRawBody(req);

          const stripeAny =
            (await getStripe("live")) ||
            (await getStripe("test")) ||
            (await getStripe());
          if (!stripeAny)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          let event = null;
          let verifiedWith = "";

          for (const secret of trySecrets) {
            try {
              event = stripeAny.webhooks.constructEvent(raw, sig, secret);
              verifiedWith =
                secret === whsecLive
                  ? "live"
                  : secret === whsecTest
                  ? "test"
                  : "fallback";
              break;
            } catch {}
          }

          if (!event) {
            console.error(
              "Webhook signature verification failed with all known secrets"
            );
            return REQ_ERR(res, 400, "invalid-signature", { requestId });
          }

          console.log(
            "[webhook] verifiedWith=",
            verifiedWith,
            "type=",
            event.type,
            "livemode=",
            !!event.livemode
          );

          switch (event.type) {
            case "checkout.session.completed": {
              const session = event.data.object;
              const mode = await resolveModeFromSession(session);

              console.log("[webhook] checkout.session.completed", {
                requestId,
                sessionId: session?.id || null,
                mode,
                verifiedWith,
                livemode: !!event.livemode,
              });

              const order = await saveOrderFromSession(session.id || session, {
                mode,
              });

              // ✅ write-once createdAt + hash (tamper detection)
              await ensureOrderIntegrityMarkers(order, requestId);

              // ✅ Centralized: immediate receipts + chair + admin copy (idempotent)
              await sendPostOrderEmails(order, requestId);

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

          return REQ_OK(res, { requestId, received: true, verifiedWith });
        } catch (e) {
          return errResponse(res, 500, "webhook-failed", req, e);
        }
      }

      if (action === "register_item") {
        const {
          id = "",
          name = "",
          chairEmails = [],
          publishStart = "",
          publishEnd = "",
          reportFrequency,
          kind,
        } = body || {};

        if (!id || !name)
          return REQ_ERR(res, 400, "id-and-name-required", { requestId });

        const emails = Array.isArray(chairEmails)
          ? chairEmails
          : String(chairEmails || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);

        const existing = await kvHgetallSafe(`itemcfg:${id}`);

        const freq = computeMergedFreq(
          reportFrequency,
          existing,
          "monthly" // register_item remains generic
        );

        const cfg = {
          ...existing,
          id,
          name,
          kind: kind || existing?.kind || "",
          chairEmails: emails,
          publishStart,
          publishEnd,
          reportFrequency: freq,
          updatedAt: new Date().toISOString(),
        };

        const ok1 = await kvHsetSafe(`itemcfg:${id}`, cfg);
        const ok2 = await kvSaddSafe("itemcfg:index", id);
        if (!ok1 || !ok2)
          return REQ_OK(res, { requestId, ok: true, warning: "kv-unavailable" });

        return REQ_OK(res, { requestId, ok: true, cfg });
      }

      // -------- ADMIN (auth required below) --------
      if (!(await requireAdminAuth(req, res))) return;

      // ✅ Lockdown enforcement (blocks admin write actions when enabled)
      if (!(await enforceLockdownIfNeeded(req, res, action, requestId))) return;

      // ✅ NEW: toggle lockdown (admin-only)
      if (action === "set_lockdown") {
        const on = coerceBool(body?.on ?? body?.enabled ?? body?.lockdown ?? false);
        const message = String(body?.message || body?.note || "").trim();
        const payload = {
          on,
          message,
          updatedAt: new Date().toISOString(),
          updatedByIp: String(getClientIp(req) || ""),
        };
        await kvSetSafe(LOCKDOWN_KEY, payload);
        return REQ_OK(res, { requestId, ok: true, lockdown: payload });
      }

      if (action === "save_feature_flags") {
        const incoming =
          body &&
          typeof body === "object" &&
          body.flags &&
          typeof body.flags === "object"
            ? body.flags
            : body && typeof body === "object"
            ? body
            : {};

        const nextFlags = { ...DEFAULT_FEATURE_FLAGS };
        for (const k of Object.keys(DEFAULT_FEATURE_FLAGS)) {
          if (k in incoming) nextFlags[k] = coerceBool(incoming[k]);
        }

        const payload = {
          flags: nextFlags,
          updatedAt: new Date().toISOString(),
        };

        await kvSetSafe(FEATURE_FLAGS_KEY, payload);
        return REQ_OK(res, { requestId, ok: true, ...payload });
      }

      if (action === "debug_schedule") {
        const id = String(body?.id || url.searchParams.get("id") || "").trim();
        if (!id) {
          return REQ_ERR(res, 400, "missing-id", {
            requestId,
            message: "Missing id (body.id or ?id=)",
          });
        }
        try {
          const result = await debugScheduleForItem(id);
          return REQ_OK(res, { requestId, ...result });
        } catch (e) {
          return errResponse(res, 500, "debug-failed", req, e);
        }
      }

      if (action === "purge_orders") {
        const confirm = String(body?.confirm || "");
        if (confirm !== "PURGE ORDERS") {
          return REQ_ERR(res, 400, "confirmation-required", {
            requestId,
            expected: "PURGE ORDERS",
            received: confirm,
            note: "This safeguard prevents accidental data loss.",
          });
        }

        let mode = String(body?.mode || "").toLowerCase() || "test";
        const hardFlag = Boolean(body?.hard);

        if (!["test", "live_test", "live"].includes(mode)) {
          return REQ_ERR(res, 400, "invalid-mode", {
            requestId,
            mode,
            expected: ["test", "live_test", "live"],
          });
        }

        try {
          const result = await purgeOrdersByMode(mode, { hard: hardFlag });
          return REQ_OK(res, {
            requestId,
            ok: true,
            message:
              mode === "live"
                ? "Live orders purge requested. Core safety rules determine whether only soft-delete is allowed."
                : `Orders for mode="${mode}" purged successfully.`,
            ...result,
          });
        } catch (err) {
          return errResponse(res, 500, "purge-failed", req, err);
        }
      }

      if (action === "get_settings") {
        const { env, overrides, effective } = await getEffectiveSettings();
        return REQ_OK(res, { requestId, ok: true, env, overrides, effective });
      }

      if (action === "send_full_report") {
        try {
          const mod = await import("./admin/send-full.js");
          const result = await mod.default();
          return REQ_OK(res, { requestId, ...(result || { ok: true }) });
        } catch (e) {
          return errResponse(res, 500, "send-full-failed", req, e);
        }
      }

      if (action === "send_month_to_date") {
        try {
          const mod = await import("./admin/send-month-to-date.js");
          const result = await mod.default();
          return REQ_OK(res, { requestId, ...(result || { ok: true }) });
        } catch (e) {
          return errResponse(res, 500, "send-mtd-failed", req, e);
        }
      }

      if (action === "send_monthly_chair_reports") {
        await loadAllOrdersWithRetry();

        let schedulerMod;
        try {
          schedulerMod = await import("./admin/report-scheduler.js");
        } catch (e) {
          return errResponse(res, 500, "scheduler-missing", req, e);
        }

        const { runScheduledChairReports } = schedulerMod || {};
        if (typeof runScheduledChairReports !== "function") {
          return REQ_ERR(res, 500, "scheduler-invalid", { requestId });
        }

        const baseNow = new Date();

        const wrappedSendItemReport = async (opts) => {
          const kind = String(opts?.kind || "").toLowerCase();

          // 5-minute phase gaps by category (banquet → add-on → catalog → other)
          // We schedule via Resend `scheduled_at` (when enabled) so the cron run
          // can finish quickly, while emails are spaced out.
          const OFFSETS_MIN = {
            banquet: 0,
            addon: 5,
            "add-on": 5,
            catalog: 10,
            supplies: 15,
            other: 20,
          };

          // Unknown kinds fall into "other"
          const offsetMinutes =
            typeof OFFSETS_MIN[kind] === "number" ? OFFSETS_MIN[kind] : OFFSETS_MIN.other;

          let scheduledAt;
          if (offsetMinutes > 0) {
            const ts = baseNow.getTime() + offsetMinutes * 60 * 1000;
            scheduledAt = new Date(ts).toISOString();
          }

          return sendItemReportEmailInternal({ ...opts, scheduledAt });
        };

        const { sent, skipped, errors, itemsLog } = await runScheduledChairReports({
          now: baseNow,
          sendItemReportEmailInternal: wrappedSendItemReport,
        });

        // ✅ Also send last-month receipts ZIP
        // (Can be disabled for testing via DISABLE_RECEIPTS_ZIP_AUTO=1)
        let receiptsZip = { ok: false, skipped: true };
        const disableReceiptsZip = String(process.env.DISABLE_RECEIPTS_ZIP_AUTO || "0") === "1";
        if (!disableReceiptsZip) {
          try {
            const now = new Date();

            // previous month in UTC
            let y = now.getUTCFullYear();
            let m = now.getUTCMonth() + 1; // 1-12 current
            m -= 1;
            if (m <= 0) {
              m = 12;
              y -= 1;
            }

            receiptsZip = await emailMonthlyReceiptsZip({
              year: y,
              month: m,
              requestId,
              auto: true,
            });

            if (receiptsZip && receiptsZip.ok) {
              try {
                await recordMailLog({
                  ts: Date.now(),
                  from: RESEND_FROM || "onboarding@resend.dev",
                  to: receiptsZip.to ? [receiptsZip.to] : [],
                  subject:
                    receiptsZip.subject ||
                    `Monthly receipts ZIP — ${String(y)}-${String(m).padStart(2, "0")}`,
                  kind: "receipts-zip-month-auto",
                  status: "queued",
                  resultId: receiptsZip.resultId || receiptsZip.id || null,
                });
              } catch {}
            }
          } catch (e) {
            console.error("receipts_zip_month_auto_failed", e?.message || e);
            receiptsZip = { ok: false, error: String(e?.message || e) };
          }
        } else {
          receiptsZip = { ok: false, skipped: true, disabled: true };
        }

        // Monthly log email to admins (REPORTS_LOG_TO)
        try {
          const logRecipients = REPORTS_LOG_TO.split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          if (resend && logRecipients.length) {
            const ts = new Date();
            const dateStr = ts.toISOString().slice(0, 10);
            const timeStr = ts.toISOString();

            const firstOfMonth = new Date(
              Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), 1, 0, 0, 0, 0)
            );
            const firstIso = firstOfMonth.toISOString();

            const esc = (s) => String(s || "").replace(/</g, "&lt;");

            const rowsHtml = (itemsLog || []).length
              ? itemsLog
                  .map((it, idx) => {
                    const status = it.skipped ? "SKIPPED" : it.ok ? "OK" : "ERROR";
                    const rowsLabel = it.skipped ? "-" : it.count;
                    const errorText = it.skipped ? it.skipReason || "" : it.error || "";

                    return `
              <tr>
                <td style="padding:4px;border:1px solid #ddd;">${idx + 1}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.id)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.label)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(it.kind)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(status)}</td>
                <td style="padding:4px;border:1px solid #ddd;">${rowsLabel}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(
                  (it.to || []).join(", ")
                )}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(
                  (it.bcc || []).join(", ")
                )}</td>
                <td style="padding:4px;border:1px solid #ddd;">${esc(errorText)}</td>
              </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="9" style="padding:6px;border:1px solid #ddd;">No items processed.</td></tr>`;

            const receiptsZipLine = (() => {
              const rz = receiptsZip || {};
              const ok = !!rz.ok;
              const err = rz.error ? String(rz.error) : "";
              const label = ok
                ? "OK"
                : rz.skipped
                ? "SKIPPED"
                : "ERROR";
              return `<p style="margin:8px 0 2px;">Receipts ZIP (auto last month): <b>${esc(
                label
              )}</b>${err ? ` — <span style="color:#b91c1c;">${esc(err)}</span>` : ""}</p>`;
            })();

            const html = `
              <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;">
                <h2 style="margin-bottom:4px;">Scheduled Chair Reports Log</h2>
                <p style="margin:2px 0;">Run time (UTC): <b>${esc(timeStr)}</b></p>
                <p style="margin:2px 0;">Scope: <b>current-month</b></p>
                <p style="margin:2px 0;"><strong>Coverage (UTC): from ${esc(
                  firstIso
                )} through ${esc(timeStr)}.</strong></p>
                <p style="margin:2px 0;font-size:12px;color:#555;">requestId: ${esc(
                  requestId
                )}</p>
                <p style="margin:6px 0 10px;">
                  Sent: <b>${sent}</b> &nbsp; | &nbsp;
                  Skipped: <b>${skipped}</b> &nbsp; | &nbsp;
                  Errors: <b>${errors}</b>
                </p>
                ${receiptsZipLine}
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
                  <tbody>${rowsHtml}</tbody>
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
          requestId,
          ok: true,
          sent,
          skipped,
          errors,
          scope: "current-month",
          receiptsZip,
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
          const publishEnd = cfg?.publishEnd ? Date.parse(cfg.publishEnd) : NaN;
          if (isNaN(publishEnd) || publishEnd > now) {
            skipped += 1;
            continue;
          }

          const already = await kvGetSafe(`itemcfg:${itemId}:end_sent`, false);
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
            await kvSetSafe(`itemcfg:${itemId}:end_sent`, new Date().toISOString());
            sent += 1;
          } else {
            errors += 1;
          }
        }

        return REQ_OK(res, {
          requestId,
          ok: true,
          sent,
          skipped,
          errors,
          scope: "full",
        });
      }

      if (action === "clear_orders") {
        await kvDelSafe("orders:index");
        return REQ_OK(res, { requestId, ok: true, message: "orders index cleared" });
      }

      if (action === "create_refund") {
        try {
          let mode = String(body?.mode || "").toLowerCase().trim();
          if (!["test", "live_test", "live"].includes(mode)) {
            mode = await getEffectiveOrderChannel().catch(() => "test");
          }

          const stripe = await getStripe(mode);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId, mode });

          const payment_intent = String(body.payment_intent || "").trim();
          const charge = String(body.charge || "").trim();
          const amount_cents_raw = body.amount_cents;
          const args = {};
          if (amount_cents_raw != null) args.amount = cents(amount_cents_raw);
          if (payment_intent) args.payment_intent = payment_intent;
          else if (charge) args.charge = charge;
          else
            return REQ_ERR(res, 400, "missing-payment_intent-or-charge", {
              requestId,
            });

          const rf = await stripe.refunds.create(args);
          try {
            await applyRefundToOrder(rf.charge, rf);
          } catch {}
          return REQ_OK(res, {
            requestId,
            ok: true,
            id: rf.id,
            status: rf.status,
            mode,
          });
        } catch (e) {
          return errResponse(res, 500, "refund-failed", req, e);
        }
      }

      // =========================================================================
      // ✅ FIXED: save_* actions no longer overwrite reportFrequency to "monthly"
      // =========================================================================

      if (action === "save_banquets") {
        const list = Array.isArray(body.banquets) ? body.banquets : [];
        await kvSetSafe("banquets", list);

        try {
          for (const b of list) {
            const id = String(b?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(b?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              b?.chairEmails,
              b?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              b?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              b?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              b?.reportFrequency ?? b?.report_frequency,
              existing,
              "daily"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: "banquet",
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      if (action === "save_addons") {
        const list = Array.isArray(body.addons) ? body.addons : [];
        await kvSetSafe("addons", list);

        try {
          for (const a of list) {
            const id = String(a?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(a?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              a?.chairEmails,
              a?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              a?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              a?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              a?.reportFrequency ?? a?.report_frequency,
              existing,
              "monthly"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: "addon",
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      if (action === "save_products") {
        const list = Array.isArray(body.products) ? body.products : [];
        await kvSetSafe("products", list);

        try {
          for (const p of list) {
            const id = String(p?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(p?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              p?.chairEmails,
              p?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              p?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              p?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              p?.reportFrequency ?? p?.report_frequency,
              existing,
              "monthly"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: "catalog",
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, count: list.length });
      }

      if (action === "save_catalog_items") {
        const cat = normalizeCat(url.searchParams.get("cat") || body?.cat || "catalog");
        const key = catalogItemsKeyForCat(cat);

        const list = Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.products)
          ? body.products
          : [];
        await kvSetSafe(key, list);

        try {
          for (const p of list) {
            const id = String(p?.id || "").trim();
            if (!id) continue;

            const existing = await kvHgetallSafe(`itemcfg:${id}`);

            const name = pickNonEmptyString(p?.name, existing?.name, id);

            const chairEmails = normalizeChairEmails(
              p?.chairEmails,
              p?.chair?.email
            );
            const mergedChairEmails =
              chairEmails.length
                ? chairEmails
                : Array.isArray(existing?.chairEmails)
                ? existing.chairEmails
                : normalizeChairEmails(existing?.chairEmails, "");

            const publishStart = pickNonEmptyString(
              p?.publishStart,
              existing?.publishStart,
              ""
            );
            const publishEnd = pickNonEmptyString(
              p?.publishEnd,
              existing?.publishEnd,
              ""
            );

            const freq = computeMergedFreq(
              p?.reportFrequency ?? p?.report_frequency,
              existing,
              "monthly"
            );

            const cfg = {
              ...existing,
              id,
              name,
              kind: cat === "catalog" ? "catalog" : `catalog:${cat}`,
              chairEmails: mergedChairEmails,
              publishStart,
              publishEnd,
              reportFrequency: freq,
              updatedAt: new Date().toISOString(),
            };

            await kvHsetSafe(`itemcfg:${id}`, cfg);
            await kvSaddSafe("itemcfg:index", id);
          }
        } catch {}

        return REQ_OK(res, { requestId, ok: true, cat, key, count: list.length });
      }

      if (action === "save_settings") {
        const allow = {};
        [
          "RESEND_FROM",
          "REPORTS_CC",
          "REPORTS_BCC",
          "EMAIL_RECEIPTS",
          "SITE_BASE_URL",
          "MAINTENANCE_ON",
          "MAINTENANCE_MESSAGE",
          "REPORTS_SEND_SEPARATE",
          "REPLY_TO",
          "EVENT_START",
          "EVENT_END",
          "REPORT_ORDER_DAYS",
          "REPORT_FREQUENCY",
          "REPORT_WEEKDAY",
        ].forEach((k) => {
          if (k in body) allow[k] = body[k];
        });

        if ("MAINTENANCE_ON" in allow)
          allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);

        if ("REPORT_FREQUENCY" in allow) {
          allow.REPORT_FREQUENCY = normalizeReportFrequency(allow.REPORT_FREQUENCY);
        }

        if ("REPORT_WEEKDAY" in allow) {
          let wd = parseInt(allow.REPORT_WEEKDAY, 10);
          if (!Number.isFinite(wd) || wd < 1 || wd > 7) wd = 1;
          allow.REPORT_WEEKDAY = String(wd);
        }

        if (Object.keys(allow).length) {
          await kvHsetSafe("settings:overrides", allow);
        }
        return REQ_OK(res, { requestId, ok: true, overrides: allow });
      }

      if (action === "save_checkout_mode") {
        const { stripeMode, liveAuto, liveStart, liveEnd } = body || {};

        let mode = String(stripeMode || "test").toLowerCase();
        if (!["test", "live_test", "live"].includes(mode)) mode = "test";

        const normalizeIso = (v) => {
          if (!v || typeof v !== "string") return "";
          const t = Date.parse(v.trim());
          if (!Number.isFinite(t)) return "";
          return new Date(t).toISOString();
        };

        const patch = {
          stripeMode: mode,
          liveAuto: !!liveAuto,
          liveStart: normalizeIso(liveStart),
          liveEnd: normalizeIso(liveEnd),
        };

        const cfg = await saveCheckoutSettings(patch);
        const effectiveChannel = await getEffectiveOrderChannel();

        return REQ_OK(res, { requestId, ok: true, cfg, effectiveChannel });
      }

      return REQ_ERR(res, 400, "unknown-action", { requestId });
    }

    return REQ_ERR(res, 405, "method-not-allowed", { requestId });
  } catch (e) {
    return errResponse(res, 500, "router-failed", req, e);
  }
}

// Vercel Node 22 runtime
export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};

