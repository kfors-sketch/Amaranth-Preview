// /api/admin/banquets.js
//
// Admin endpoint to GET/POST the canonical banquets list.
// - Persists to Redis if REDIS_URL is set, else to Vercel KV if available.
// - POST requires Authorization: Bearer <REPORT_TOKEN>
// - Normalizes eventAt (ISO) and keeps legacy .datetime (pretty string) in sync.

import { kv as vercelKV } from "@vercel/kv";          // optional fallback
import { createClient as createRedisClient } from "redis";

const KEY = "banquets:list";

// ---- Storage helpers: prefer Redis, fallback to Vercel KV ----
let redisClient = null;
async function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;
  redisClient = createRedisClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (e) => console.error("[redis] error", e));
  await redisClient.connect();
  return redisClient;
}

async function saveJSON(key, value) {
  const asStr = JSON.stringify(value);
  const redis = await getRedis();
  if (redis) {
    await redis.set(key, asStr);
    return;
  }
  // Fallback to Vercel KV if configured
  if (vercelKV) {
    await vercelKV.set(key, asStr);
    return;
  }
  throw new Error("No storage configured (set REDIS_URL or Vercel KV).");
}

async function loadJSON(key) {
  const redis = await getRedis();
  if (redis) {
    const str = await redis.get(key);
    return str ? JSON.parse(str) : null;
  }
  if (vercelKV) {
    const str = await vercelKV.get(key);
    // vercelKV.get may already parse JSON; handle both forms safely:
    if (typeof str === "string") return JSON.parse(str);
    if (str && typeof str === "object") return str; // already parsed
    return null;
  }
  throw new Error("No storage configured (set REDIS_URL or Vercel KV).");
}

// ---- Auth helper ----
function requireBearerToken(req) {
  const hdr = req.headers.authorization || req.headers.Authorization;
  const want = process.env.REPORT_TOKEN;
  if (!want) return { ok: false, reason: "REPORT_TOKEN not set on server" };
  if (!hdr || !hdr.startsWith("Bearer ")) return { ok: false, reason: "Missing bearer token" };
  const got = hdr.slice("Bearer ".length).trim();
  if (got !== want) return { ok: false, reason: "Invalid token" };
  return { ok: true };
}

// ---- Validation / normalization ----
const idOK = (id) => /^[a-z0-9-]+$/.test(id);
const emailOK = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

function prettyFromISO(iso) {
  // Server-side pretty string; client will often re-render anyway.
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    // Use a stable, readable format (US English fallback)
    return d.toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function normalizeItem(b) {
  const out = { ...b };

  // eventAt: ensure ISO or blank
  if (out.eventAt) {
    const d = new Date(out.eventAt);
    out.eventAt = isNaN(d) ? "" : d.toISOString();
  } else {
    out.eventAt = "";
  }

  // Keep legacy human string in sync if possible
  if (!out.datetime && out.eventAt) {
    out.datetime = prettyFromISO(out.eventAt);
  }

  // Normalize common fields to safe defaults
  out.id = (out.id || "").trim();
  out.name = (out.name || "").trim();
  out.active = out.active !== false;
  out.price = Number(out.price || 0);
  out.location = (out.location || "").trim();
  out.notes = (out.notes || out.description || "").trim();
  out.publishStart = out.publishStart ? new Date(out.publishStart).toISOString() : "";
  out.publishEnd   = out.publishEnd   ? new Date(out.publishEnd).toISOString()   : "";

  // Chair emails as array
  const emails = Array.isArray(out.chairEmails)
    ? out.chairEmails
    : (out.chair && out.chair.email ? [out.chair.email] : []);
  out.chairEmails = emails.filter(Boolean);

  // Meals (editor uses "meals"; public file used "mealChoices")
  if (!Array.isArray(out.meals) && Array.isArray(out.mealChoices)) {
    out.meals = out.mealChoices;
  }
  if (!Array.isArray(out.meals)) out.meals = [];

  return out;
}

function validateItem(b) {
  if (!b.name) return "Name is required";
  if (!b.id) return "ID is required";
  if (!idOK(b.id)) return "ID must be lowercase letters, numbers, and dashes only";
  if (b.price < 0) return "Price cannot be negative";
  for (const e of b.chairEmails || []) {
    if (!emailOK(e)) return `Invalid email: ${e}`;
  }
  if (b.publishStart && isNaN(new Date(b.publishStart))) return "Publish start is invalid";
  if (b.publishEnd && isNaN(new Date(b.publishEnd))) return "Publish end is invalid";
  if (b.publishStart && b.publishEnd && new Date(b.publishStart) > new Date(b.publishEnd)) {
    return "Publish start must be before publish end";
  }
  if (b.eventAt && isNaN(new Date(b.eventAt))) return "Event date/time is invalid";
  return null;
}

// ---- Route handler ----
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // Return whatever is stored (or 404 if nothing yet)
      let list = null;
      try { list = await loadJSON(KEY); }
      catch (e) {
        console.warn("[banquets admin GET] storage not configured:", e.message);
        return res.status(501).json({ error: "storage-not-configured" });
      }
      if (!Array.isArray(list)) {
        return res.status(404).json({ error: "no-banquets-stored" });
      }
      return res.status(200).json({ banquets: list });
    }

    if (req.method === "POST") {
      const auth = requireBearerToken(req);
      if (!auth.ok) {
        return res.status(401).json({ error: "unauthorized", details: auth.reason });
      }
      const body = req.body || {};
      const incoming = Array.isArray(body.banquets) ? body.banquets : [];
      if (!incoming.length) {
        return res.status(400).json({ error: "banquets-array-required" });
      }
      if (incoming.length > 500) {
        return res.status(413).json({ error: "too-many-items" });
      }

      const normalized = [];
      for (const raw of incoming) {
        const n = normalizeItem(raw);
        const err = validateItem(n);
        if (err) {
          return res.status(422).json({ error: "validation-failed", details: [err, `item id: ${raw?.id ?? "(none)"}`] });
        }
        normalized.push(n);
      }

      try {
        await saveJSON(KEY, normalized);
      } catch (e) {
        console.error("[banquets admin POST] save failed:", e);
        return res.status(500).json({ error: "persist-failed" });
      }

      return res.status(200).json({ ok: true, count: normalized.length });
    }

    return res.status(405).json({ error: "method-not-allowed" });
  } catch (e) {
    console.error("[banquets admin] unexpected error:", e);
    return res.status(500).json({ error: "internal-error" });
  }
}
