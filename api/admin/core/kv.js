import { kv } from "@vercel/kv";

async function kvGetSafe(key, fallback = null) {
  try {
    const v = await kv.get(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
async function kvHsetSafe(key, obj) {
  try {
    await kv.hset(key, obj);
    return true;
  } catch {
    return false;
  }
}
async function kvSaddSafe(key, val) {
  try {
    await kv.sadd(key, val);
    return true;
  } catch {
    return false;
  }
}
async function kvSetSafe(key, val) {
  try {
    await kv.set(key, val);
    return true;
  } catch {
    return false;
  }
}
async function kvHgetallSafe(key) {
  try {
    return (await kv.hgetall(key)) || {};
  } catch {
    return {};
  }
}
async function kvSmembersSafe(key) {
  try {
    return (await kv.smembers(key)) || [];
  } catch {
    return [];
  }
}
async function kvDelSafe(key) {
  try {
    await kv.del(key);
    return true;
  } catch {
    return false;
  }
}

// Small sleep helper for retries

export { kv, kvGetSafe, kvHsetSafe, kvSaddSafe, kvSetSafe, kvHgetallSafe, kvSmembersSafe, kvDelSafe };
