import { resend } from "./env.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Email retry helper (3 attempts, spacing 2s → 5s → 10s) ----
async function sendWithRetry(sendFn, label = "email") {
  const attempts = [0, 2000, 5000, 10000];
  let lastErr = null;

  for (let i = 1; i <= 3; i++) {
    try {
      if (attempts[i] > 0) await sleep(attempts[i]);
      const result = await sendFn();
      return { ok: true, attempt: i, result };
    } catch (err) {
      lastErr = err;
      console.error(`Retry ${i} failed for ${label}:`, err);
    }
  }
  return { ok: false, error: lastErr };
}

// ---------------------------------------------------------------------------
// ORDER HASHING (immutable receipt / tamper detection)
// ---------------------------------------------------------------------------


export { sleep, sendWithRetry };
