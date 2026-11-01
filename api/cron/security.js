import crypto from "crypto";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function authorizeCronRequest(req, secret) {
  const configured = String(secret || "").trim();
  if (!configured) return false;
  const supplied = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  return safeEqual(supplied, `Bearer ${configured}`);
}

function periodFor(kind, now) {
  const iso = now.toISOString();
  return kind === "monthly" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export async function runScheduledReport({
  kind, action, req, res, kv, fetchImpl = fetch, env = process.env, now = new Date(),
}) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method-not-allowed" });
  if (!authorizeCronRequest(req, env.CRON_SECRET)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const base = String(env.SITE_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+/i.test(base)) {
    return res.status(500).json({ ok: false, error: "trusted-site-url-required" });
  }
  const routerToken = String(env.REPORT_TOKEN || "").trim();
  if (!routerToken) return res.status(500).json({ ok: false, error: "router-auth-missing" });

  const period = periodFor(kind, now);
  const prefix = `cron:${kind}:${period}`;
  if (await kv.get(`${prefix}:complete`)) {
    return res.status(200).json({ ok: true, period, skipped: "already-complete" });
  }
  const claim = await kv.set(`${prefix}:claim`, now.toISOString(), { nx: true, ex: 30 * 60 });
  if (!(claim === "OK" || claim === true)) {
    return res.status(200).json({ ok: true, period, skipped: "already-running" });
  }

  try {
    const response = await fetchImpl(new URL(`/api/router?action=${action}`, base).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${routerToken}` },
      body: JSON.stringify({ via: "cron", period }),
    });
    const data = await response.json().catch(() => ({}));
    const succeeded = response.ok && Number(data?.errors || 0) === 0 && data?.ok !== false;
    const audit = { ranAt: now.toISOString(), period, succeeded, status: response.status };
    await kv.set(`${prefix}:last-run`, audit);
    if (!succeeded) {
      await kv.set(`${prefix}:failure`, audit);
      await kv.del(`${prefix}:claim`);
      return res.status(500).json({ ok: false, error: "scheduled-report-failed", period });
    }
    await kv.set(`${prefix}:complete`, audit);
    await kv.del(`${prefix}:claim`);
    return res.status(200).json({ ok: true, period });
  } catch (_error) {
    const audit = { ranAt: now.toISOString(), period, succeeded: false, status: 0 };
    await kv.set(`${prefix}:last-run`, audit);
    await kv.set(`${prefix}:failure`, audit);
    await kv.del(`${prefix}:claim`);
    return res.status(500).json({ ok: false, error: "scheduled-report-failed", period });
  }
}

