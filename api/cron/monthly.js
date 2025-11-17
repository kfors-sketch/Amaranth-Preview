// /api/cron/monthly.js
// Cron entrypoint that calls the router's send_monthly_chair_reports action.

export default async function handler(req, res) {
  try {
    // Prefer SITE_BASE_URL if you set it in Vercel env; otherwise fall back to current host.
    const base =
      (process.env.SITE_BASE_URL || "").replace(/\/+$/, "") ||
      `https://${req.headers.host}`;

    const url = new URL("/api/router?action=send_monthly_chair_reports", base);
    const token = process.env.REPORT_TOKEN || "";

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({})
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error("send_monthly_chair_reports via cron failed:", data);
      return res
        .status(500)
        .json({ ok: false, error: "send_monthly_chair_reports-failed", data });
    }

    console.log("send_monthly_chair_reports via cron success:", data);
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("monthly cron top-level error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "cron-failed", message: String(e?.message || e) });
  }
}