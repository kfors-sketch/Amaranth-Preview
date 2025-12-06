// /api/cron/closing.js

export default async function handler(req, res) {
  // ---- Debug Log Version Tag ----
  console.log("closing.js version: v2 – using REPORT_TOKEN and router-error wrapper");

  try {
    const token = process.env.REPORT_TOKEN || "";
    if (!token) {
      console.error("REPORT_TOKEN missing; cannot auth router for closing cron");
      return res.status(500).json({ ok: false, error: "missing-REPORT_TOKEN" });
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const host = req.headers.host || "";
    const baseEnv = process.env.SITE_BASE_URL || "";
    const origin = (baseEnv && /^https?:\/\//i.test(baseEnv)
      ? baseEnv
      : `https://${host}`
    ).replace(/\/+$/, "");

    // If you ever want to support ?banquetId= for a single item later,
    // you could pass it in the body here. For now, we just run all.
    // const onlyId = urlObj.searchParams.get("banquetId") || "";

    const resp = await fetch(`${origin}/api/router?action=send_end_of_event_reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("send_end_of_event_reports via cron failed:", data);
      return res.status(500).json({
        ok: false,
        error: "router-error",
        ...data,
      });
    }

    return res.status(200).json({
      ok: true,
      source: "cron/closing",
      ...data,
    });

  } catch (e) {
    console.error("closing cron fatal error:", e);
    return res.status(500).json({
      ok: false,
      error: "closing-failed",
      message: e?.message || String(e),
    });
  }
}
