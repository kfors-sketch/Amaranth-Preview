// /api/cron/monthly.js
// Cron entrypoint that calls the router's send_monthly_chair_reports action.

import { kv } from "@vercel/kv";

/**
 * Record a small heartbeat in KV so we can see if cron actually fired.
 * Key: cron:monthly:last-run
 */
async function markCronHeartbeat(ok, extra = {}) {
  try {
    const payload = {
      ok: !!ok,
      ts: new Date().toISOString(),
      ...extra
    };
    await kv.set("cron:monthly:last-run", JSON.stringify(payload));
  } catch (err) {
    console.error("Failed to mark cron heartbeat:", err);
    // Never throw from here; we don't want heartbeat logging to break cron.
  }
}

export default async function handler(req, res) {
  try {
    // Prefer SITE_BASE_URL if you set it in Vercel env; otherwise fall back to current host.
    const baseFromEnv = (process.env.SITE_BASE_URL || "").trim().replace(/\/+$/, "");
    const fallbackHost = req.headers?.host ? `https://${req.headers.host}` : "";
    const base = baseFromEnv || fallbackHost;

    if (!base) {
      console.error("monthly cron error: no base URL (SITE_BASE_URL/env host missing)");
      await markCronHeartbeat(false, { reason: "no-base-url" });
      return res
        .status(500)
        .json({ ok: false, error: "no-base-url", message: "No base URL resolved" });
    }

    const url = new URL("/api/router?action=send_monthly_chair_reports", base);
    const token = (process.env.REPORT_TOKEN || "").trim();

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ via: "cron" })
    });

    let data = null;
    try {
      data = await resp.json();
    } catch {
      // If the router didn’t return JSON, keep data as null but don’t crash.
      data = null;
    }

    if (!resp.ok) {
      console.error("send_monthly_chair_reports via cron failed:", {
        status: resp.status,
        data
      });
      await markCronHeartbeat(false, { status: resp.status, data });
      return res.status(500).json({
        ok: false,
        error: "send_monthly_chair_reports-failed",
        status: resp.status,
        data
      });
    }

    console.log("send_monthly_chair_reports via cron success:", data);
    await markCronHeartbeat(true, { status: resp.status });

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("monthly cron top-level error:", e);
    await markCronHeartbeat(false, {
      reason: "exception",
      message: String(e?.message || e)
    });
    return res.status(500).json({
      ok: false,
      error: "cron-failed",
      message: String(e?.message || e)
    });
  }
}
