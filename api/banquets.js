// /api/banquets.js
// Public reader for the canonical banquets list.
// Reads from Redis key "banquets:list" (set by /api/admin/banquets.js).
// Returns 200 with { banquets: [...] } or 404 if nothing stored yet.

import { createClient as createRedisClient } from "redis";

const KEY = "banquets:list";

let redisClient = null;
async function getRedis() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set");
  }
  if (redisClient) return redisClient;
  redisClient = createRedisClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (e) => console.error("[redis] error", e));
  await redisClient.connect();
  return redisClient;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method-not-allowed" });
  }

  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);

    if (!raw) {
      // Nothing has been saved yet by the admin endpoint.
      return res.status(404).json({ error: "no-banquets-stored" });
    }

    let banquets;
    try {
      banquets = JSON.parse(raw);
    } catch {
      console.error("[/api/banquets] stored value is not valid JSON");
      return res.status(500).json({ error: "corrupt-data" });
    }

    if (!Array.isArray(banquets)) {
      return res.status(500).json({ error: "invalid-format" });
    }

    // Don't cache; always serve the latest
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ banquets });
  } catch (e) {
    console.error("[/api/banquets] error:", e);
    return res.status(500).json({ error: "internal-error" });
  }
}
