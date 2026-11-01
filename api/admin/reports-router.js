// /api/admin/reports-router.js
import {
  REQ_OK,
  REQ_ERR,
  kv,
  kvGetSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvHsetSafe,
  kvSaddSafe,
  kvSmembersSafe,
  loadAllOrdersWithRetry,
  parseYMD,
  normalizeReportFrequency,
  getEffectiveSettings,
  sendItemReportEmailInternal,
  emailWeeklyReceiptsZip,
  emailMonthlyReceiptsZip,
} from "./core.js";

import {
  getReportingPrefs,
  setReportingPrefs,
  resolveChannel,
  shouldSendReceiptZip,
} from "./report-channel.js";

import { handleChairPreview } from "../../admin/debug.js";

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !!v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

async function getEffectiveReportMode() {
  const prefs = await getReportingPrefs();
  const isProduction =
    String(process.env.VERCEL_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const mode = resolveChannel({ requested: prefs.channel, isProduction });
  return { prefs, mode };
}

export async function handleReportsRoute(req, res, ctx = {}) {
  const {
    url,
    type,
    action,
    body = {},
    requestId,
    requireAdminAuth,
    enforceLockdownIfNeeded,
    errResponse,
  } = ctx;

  // --------------------------------------------------------------------
  // GET /api/router?type=send_item_report&... compatibility/testing route
  // --------------------------------------------------------------------
  if (req.method === "GET" && type === "send_item_report") {
    if (!(await requireAdminAuth(req, res))) return true;
    if (!(await enforceLockdownIfNeeded(req, res, "send_item_report", requestId))) return true;

    const kind = String(url.searchParams.get("kind") || "").trim().toLowerCase();
    const id = String(url.searchParams.get("id") || "").trim();
    const label = String(url.searchParams.get("label") || "").trim();
    const scope = String(url.searchParams.get("scope") || "current-month").trim();
    const dryRun = coerceBool(
      url.searchParams.get("dryRun") || url.searchParams.get("dry_run") || ""
    );

    if (!id) return REQ_ERR(res, 400, "missing-id", { requestId });

    if (dryRun) {
      try {
        const out = await handleChairPreview({ id, scope });
        return REQ_OK(res, {
          requestId,
          ok: true,
          dryRun: true,
          kind: kind || out?.kind || "",
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

    try {
      const startMs = Number(url.searchParams.get("startMs") || "");
      const endMs = Number(url.searchParams.get("endMs") || "");
      const payload = { kind, id, label, scope };

      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        payload.startMs = startMs;
        payload.endMs = endMs;
      }

      const result = await sendItemReportEmailInternal(payload);
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

  if (req.method !== "POST") return false;

  if (action === "send_item_report") {
    if (!(await requireAdminAuth(req, res))) return true;
    if (!(await enforceLockdownIfNeeded(req, res, "send_item_report", requestId))) return true;

    try {
      const kind = String(body?.kind || body?.category || "").toLowerCase();
      const id = String(body?.id || "").trim();
      const label = String(body?.label || "").trim();
      const scope = String(body?.scope || "current-month");

      const payload = { kind, id, label, scope };

      const startYMD = String(body?.startYMD || body?.start || body?.from || "").trim();
      const endYMD = String(body?.endYMD || body?.end || body?.to || "").trim();

      if (scope === "custom") {
        if (startYMD) payload.startMs = parseYMD(startYMD);
        if (endYMD) {
          let endMs = parseYMD(endYMD);
          if (!isNaN(endMs) && /^\d{4}-\d{2}-\d{2}$/.test(endYMD)) {
            endMs += 24 * 60 * 60 * 1000;
          }
          payload.endMs = endMs;
        }
      }

      const result = await sendItemReportEmailInternal(payload);
      if (!result.ok) {
        return REQ_ERR(res, 500, result.error || "send-failed", {
          requestId,
          ...result,
        });
      }
      return REQ_OK(res, { requestId, ok: true, ...result });
    } catch (e) {
      return errResponse(res, 500, "send-item-report-failed", req, e);
    }
  }

  if (action === "register_item") {
    if (!(await requireAdminAuth(req, res))) return true;
    if (!(await enforceLockdownIfNeeded(req, res, "register_item", requestId))) return true;

    const {
      id = "",
      name = "",
      chairEmails = [],
      publishStart = "",
      publishEnd = "",
      reportFrequency,
      kind,
    } = body || {};

    if (!id || !name) return REQ_ERR(res, 400, "id-and-name-required", { requestId });

    const emails = Array.isArray(chairEmails)
      ? chairEmails
      : String(chairEmails || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    const existing = await kvHgetallSafe(`itemcfg:${id}`);
    const raw = reportFrequency ?? existing?.reportFrequency ?? existing?.report_frequency ?? "monthly";
    const freq = normalizeReportFrequency(raw);

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
    if (!ok1 || !ok2) {
      return REQ_OK(res, { requestId, ok: true, warning: "kv-unavailable" });
    }

    return REQ_OK(res, { requestId, ok: true, cfg });
  }

  if (action === "set_reporting_channel") {
    if (!(await requireAdminAuth(req, res))) return true;
    const channel = String(body?.channel || "").trim();
    const next = await setReportingPrefs({ channel });
    return REQ_OK(res, { requestId, ok: true, prefs: next });
  }

  const adminReportActions = new Set([
    "send_monthly_chair_reports",
    "send_test_chair_reports",
    "send_end_of_event_reports",
  ]);

  if (!adminReportActions.has(String(action || ""))) return false;

  if (!(await requireAdminAuth(req, res))) return true;
  if (!(await enforceLockdownIfNeeded(req, res, action, requestId))) return true;

  if (action === "send_monthly_chair_reports") {
    await loadAllOrdersWithRetry();

    let schedulerMod;
    try {
      schedulerMod = await import("./report-scheduler.js");
    } catch (e) {
      return errResponse(res, 500, "scheduler-missing", req, e);
    }

    const { runScheduledChairReports } = schedulerMod || {};
    if (typeof runScheduledChairReports !== "function") {
      return REQ_ERR(res, 500, "scheduler-invalid", { requestId });
    }

    const baseNow = new Date();
    const { prefs: reportingPrefs, mode: reportMode } = await getEffectiveReportMode();

    const wrappedSendItemReport = async (opts) => {
      const kind = String(opts?.kind || "").toLowerCase();
      const OFFSETS_MIN = {
        banquet: 0,
        addon: 5,
        "add-on": 5,
        catalog: 10,
        supplies: 15,
        other: 20,
      };
      const offsetMinutes =
        typeof OFFSETS_MIN[kind] === "number" ? OFFSETS_MIN[kind] : OFFSETS_MIN.other;

      let scheduledAt;
      if (offsetMinutes > 0) {
        const ts = baseNow.getTime() + offsetMinutes * 60 * 1000;
        scheduledAt = new Date(ts).toISOString();
      }

      return sendItemReportEmailInternal({ ...opts, scheduledAt, mode: reportMode });
    };

    const { sent, skipped, errors, itemsLog } = await runScheduledChairReports({
      now: baseNow,
      sendItemReportEmailInternal: wrappedSendItemReport,
    });

    let receiptsZip = {
      monthly: { ok: false, skipped: true },
      weekly: { ok: false, skipped: true },
    };
    const disableReceiptsZip = String(process.env.DISABLE_RECEIPTS_ZIP_AUTO || "0") === "1";
    if (!disableReceiptsZip) {
      try {
        if (shouldSendReceiptZip({ prefs: reportingPrefs, kind: "weekly" })) {
          receiptsZip.weekly = await emailWeeklyReceiptsZip({ mode: reportMode });
        }
        if (shouldSendReceiptZip({ prefs: reportingPrefs, kind: "monthly" })) {
          receiptsZip.monthly = await emailMonthlyReceiptsZip({ mode: reportMode });
        }
      } catch (e) {
        console.error("receipts_zip_auto_failed", e?.message || e);
      }
    }

    return REQ_OK(res, {
      requestId,
      ok: true,
      sent,
      skipped,
      errors,
      scope: "current-month",
      receiptsZip,
      itemsLog,
    });
  }

  if (action === "send_test_chair_reports") {
    const { effective } = await getEffectiveSettings();
    const to = String(
      body?.to ||
        effective?.TEST_REPORT_TO ||
        process.env.TEST_REPORT_TO ||
        effective?.REPORTS_LOG_TO ||
        process.env.REPORTS_LOG_TO ||
        ""
    ).trim();
    const frequency = String(body?.frequency || "monthly").trim().toLowerCase();
    const scope = String(body?.scope || "current-month").trim();
    const previewOnly = !!body?.previewOnly;

    const { mode: reportMode } = await getEffectiveReportMode();
    if (!to) return REQ_ERR(res, 400, "missing-test-email", { requestId });

    const freqNorm = frequency === "all" ? "all" : normalizeReportFrequency(frequency);

    await loadAllOrdersWithRetry();
    const ids = await kvSmembersSafe("itemcfg:index");

    let sent = 0,
      skipped = 0,
      errors = 0;

    const results = [];

    for (const itemId of ids) {
      const cfg = await kvHgetallSafe(`itemcfg:${itemId}`);
      const itemFreq = normalizeReportFrequency(cfg?.reportFrequency || cfg?.frequency || "monthly");

      if (freqNorm !== "all" && itemFreq !== freqNorm) {
        skipped++;
        continue;
      }

      try {
        const r = await sendItemReportEmailInternal({
          kind: cfg?.kind || cfg?.type || "item",
          id: itemId,
          label: cfg?.label || cfg?.name || itemId,
          scope,
          toOverride: [to],
          subjectPrefix: `[TEST ${freqNorm}] `,
          previewOnly,
          mode: reportMode,
        });

        if (r?.ok) sent++;
        else errors++;

        results.push({
          itemId,
          ok: !!r?.ok,
          preview: !!r?.preview,
          rowCount: r?.rowCount || 0,
          error: r?.error || null,
        });
      } catch (e) {
        errors++;
        results.push({ itemId, ok: false, error: e?.message || String(e) });
      }
    }

    return REQ_OK(res, {
      requestId,
      ok: true,
      to,
      frequency: freqNorm,
      scope,
      previewOnly,
      sent,
      skipped,
      errors,
      results,
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

  return false;
}
