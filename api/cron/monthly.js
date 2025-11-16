// /api/cron/monthly.js

export default async function handler(req, res) {
  try {
    const token = process.env.REPORT_TOKEN || "";
    if (!token) {
      console.error("REPORT_TOKEN missing; cannot auth router for monthly cron");
      return res.status(500).json({ ok: false, error: "missing-REPORT_TOKEN" });
    }

    // Build base URL (prefer SITE_BASE_URL if set)
    const host = req.headers.host || "";
    const baseEnv = process.env.SITE_BASE_URL || "";
    const origin = (baseEnv && /^https?:\/\//i.test(baseEnv)
      ? baseEnv
      : `https://${host}`
    ).replace(/\/+$/, "");

    // Call router's monthly chair-report action
    const resp = await fetch(`${origin}/api/router?action=send_monthly_chair_reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({}), // no extra params for now
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("send_monthly_chair_reports via cron failed:", data);
      return res.status(500).json({
        ok: false,
        error: "router-error",
        ...data,
      });
    }

    return res.status(200).json({
      ok: true,
      source: "cron/monthly",
      ...data,
    });
  } catch (e) {
    console.error("monthly cron fatal error:", e);
    return res.status(500).json({
      ok: false,
      error: "cron-failed",
      message: e?.message || String(e),
    });
  }
}
