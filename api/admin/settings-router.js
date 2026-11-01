// /api/admin/settings-router.js
// Handles settings, feature flags, lockdown status, and checkout mode config.

import {
  REQ_OK,
  REQ_ERR,
  kvGetSafe,
  kvSetSafe,
  kvHsetSafe,
  getEffectiveSettings,
  normalizeReportFrequency,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
} from "./core.js";

const FEATURE_FLAGS_KEY = "feature_flags";
const LOCKDOWN_KEY = "security:lockdown";

const DEFAULT_FEATURE_FLAGS = {
  supplies_live: false,
  supplies_preview: false,
  banquets_v2_preview: false,
  catalog_v2_preview: false,
};

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !!v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

async function loadFeatureFlagsSafe() {
  const raw = (await kvGetSafe(FEATURE_FLAGS_KEY, null)) || null;

  const storedFlags =
    raw && typeof raw === "object"
      ? raw.flags && typeof raw.flags === "object"
        ? raw.flags
        : raw
      : {};

  const merged = { ...DEFAULT_FEATURE_FLAGS, ...(storedFlags || {}) };

  const cleaned = {};
  for (const k of Object.keys(DEFAULT_FEATURE_FLAGS)) {
    cleaned[k] = coerceBool(merged[k]);
  }

  const updatedAt =
    raw && typeof raw === "object" && typeof raw.updatedAt === "string"
      ? raw.updatedAt
      : "";

  return { flags: cleaned, updatedAt };
}

function normalizeIso(v) {
  if (!v || typeof v !== "string") return "";
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString();
}

export async function handleSettingsRoute(req, res, ctx = {}) {
  const {
    url,
    type,
    action,
    body = {},
    requestId,
    requireAdminAuth,
    enforceLockdownIfNeeded,
    getLockdownStateSafe,
    isLockdownBypassed,
    getClientIp,
    errResponse,
  } = ctx;

  if (req.method === "GET") {
    if (type === "lockdown_status") {
      if (!(await requireAdminAuth(req, res))) return true;
      const st = await getLockdownStateSafe();
      const bypass = await isLockdownBypassed(req);
      return !!REQ_OK(res, {
        requestId,
        ok: true,
        lockdown: st,
        bypass,
        ip: String(getClientIp(req) || ""),
      });
    }

    if (type === "settings") {
      const { env, overrides, effective } = await getEffectiveSettings();

      const authHeader = String(
        req?.headers?.authorization || req?.headers?.Authorization || ""
      ).trim();

      // Public pages only need the maintenance banner state. Operational
      // configuration is returned exclusively to an authenticated admin.
      if (!authHeader) {
        return !!REQ_OK(res, {
          requestId,
          MAINTENANCE_ON: effective.MAINTENANCE_ON,
          MAINTENANCE_MESSAGE:
            effective.MAINTENANCE_MESSAGE || env.MAINTENANCE_MESSAGE || "",
        });
      }

      if (!(await requireAdminAuth(req, res))) return true;
      const lockdown = await getLockdownStateSafe().catch(() => ({
        on: false,
        message: "",
        updatedAt: "",
      }));
      return !!REQ_OK(res, {
        requestId,
        env,
        overrides,
        effective,
        MAINTENANCE_ON: effective.MAINTENANCE_ON,
        MAINTENANCE_MESSAGE:
          effective.MAINTENANCE_MESSAGE || env.MAINTENANCE_MESSAGE,
        lockdown,
      });
    }

    if (type === "feature_flags") {
      if (!(await requireAdminAuth(req, res))) return true;
      const { flags, updatedAt } = await loadFeatureFlagsSafe();
      return !!REQ_OK(res, { requestId, flags, updatedAt });
    }

    if (type === "checkout_mode") {
      if (!(await requireAdminAuth(req, res))) return true;
      const nowMs = Date.now();
      const raw = await getCheckoutSettingsAuto(new Date(nowMs));
      const effectiveChannel = await getEffectiveOrderChannel(new Date(nowMs));

      const startMs = raw.liveStart ? Date.parse(raw.liveStart) : NaN;
      const endMs = raw.liveEnd ? Date.parse(raw.liveEnd) : NaN;
      const windowActive =
        !isNaN(startMs) &&
        nowMs >= startMs &&
        (isNaN(endMs) || nowMs <= endMs);

      return !!REQ_OK(res, {
        requestId,
        raw,
        auto: { now: new Date(nowMs).toISOString(), windowActive },
        effectiveChannel,
      });
    }

    return false;
  }

  if (req.method === "POST") {
    const settingsActions = new Set([
      "set_lockdown",
      "save_feature_flags",
      "get_settings",
      "save_settings",
      "save_checkout_mode",
    ]);

    if (!settingsActions.has(String(action || ""))) return false;

    if (!(await requireAdminAuth(req, res))) return true;
    if (!(await enforceLockdownIfNeeded(req, res, action, requestId))) return true;

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
      return !!REQ_OK(res, { requestId, ok: true, lockdown: payload });
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
      return !!REQ_OK(res, { requestId, ok: true, ...payload });
    }

    if (action === "get_settings") {
      const { env, overrides, effective } = await getEffectiveSettings();
      return !!REQ_OK(res, { requestId, ok: true, env, overrides, effective });
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

      if ("MAINTENANCE_ON" in allow) {
        allow.MAINTENANCE_ON = String(!!allow.MAINTENANCE_ON);
      }

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
      return !!REQ_OK(res, { requestId, ok: true, overrides: allow });
    }

    if (action === "save_checkout_mode") {
      const { stripeMode, liveAuto, liveStart, liveEnd } = body || {};

      let mode = String(stripeMode || "test").toLowerCase();
      if (!["test", "live_test", "live"].includes(mode)) mode = "test";

      const patch = {
        stripeMode: mode,
        liveAuto: !!liveAuto,
        liveStart: normalizeIso(liveStart),
        liveEnd: normalizeIso(liveEnd),
      };

      const cfg = await saveCheckoutSettings(patch);
      const effectiveChannel = await getEffectiveOrderChannel();

      return !!REQ_OK(res, { requestId, ok: true, cfg, effectiveChannel });
    }
  }

  return false;
}
