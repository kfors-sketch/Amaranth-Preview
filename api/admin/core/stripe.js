import crypto from "crypto";
import { kv } from "@vercel/kv";

// ============================================================================
// STRIPE MODE-AWARE KEY SELECTION
// ============================================================================

// Cache Stripe clients by secret key (so switching modes doesn't create duplicates)
let _stripeBySecret = Object.create(null);

/**
 * Returns the Stripe SECRET client for the *current effective mode*.
 * Modes:
 *   test      → STRIPE_SECRET_KEY_TEST
 *   live_test → STRIPE_SECRET_KEY_LIVE
 *   live      → STRIPE_SECRET_KEY_LIVE
 *
 * Auto-reverts to test whenever the LIVE window is expired (via
 * getEffectiveOrderChannel()).
 */
async function getStripe() {
  let mode = "test";
  try {
    mode = await getEffectiveOrderChannel(); // defined further below
  } catch (e) {
    console.error(
      "getStripe: failed to resolve effective order channel, falling back to test.",
      e
    );
    mode = "test";
  }

  const env = process.env || {};
  const TEST_SECRET = (env.STRIPE_SECRET_KEY_TEST || "").trim();
  const LIVE_SECRET = (env.STRIPE_SECRET_KEY_LIVE || "").trim();

  let key = "";
  if (mode === "test") key = TEST_SECRET;
  else key = LIVE_SECRET; // live_test + live both use LIVE key

  if (!key) {
    console.error("getStripe: No valid Stripe secret key configured for mode:", mode);
    return null;
  }

  if (_stripeBySecret[key]) return _stripeBySecret[key];

  const { default: Stripe } = await import("stripe");
  const client = new Stripe(key);
  _stripeBySecret[key] = client;
  return client;
}

/**
 * Returns the correct STRIPE PUBLISHABLE KEY for front-end usage.
 * This should be called by router.js when building checkout sessions.
 *
 * @param {string} mode - effectiveChannel (test | live_test | live)
 */
function getStripePublishableKey(mode = "test") {
  const env = process.env || {};
  const TEST_PK = (env.STRIPE_PUBLISHABLE_KEY_TEST || "").trim();
  const LIVE_PK = (env.STRIPE_PUBLISHABLE_KEY_LIVE || "").trim();
  if (mode === "test") return TEST_PK;
  return LIVE_PK; // live_test + live
}

// ---- Checkout mode & window settings ----
const CHECKOUT_SETTINGS_KEY = "settings:checkout";

/**
 * Raw checkout settings from KV.
 * {
 *   stripeMode: "test" | "live_test" | "live",
 *   liveAuto: boolean (legacy – now treated as always-on),
 *   liveStart: string,
 *   liveEnd:   string
 * }
 */
async function getCheckoutSettingsRaw() {
  const s = await kv.get(CHECKOUT_SETTINGS_KEY);
  if (!s || typeof s !== "object") {
    return {
      stripeMode: "test",
      liveAuto: true,
      liveStart: "",
      liveEnd: "",
    };
  }
  const out = { ...s };
  if (!out.stripeMode) out.stripeMode = "test";
  if (out.liveAuto === undefined || out.liveAuto === null) out.liveAuto = true;
  return out;
}

async function saveCheckoutSettings(patch = {}) {
  const current = await getCheckoutSettingsRaw();
  const next = { ...current, ...patch };
  await kv.set(CHECKOUT_SETTINGS_KEY, next);
  return next;
}

/**
 * Same as raw, but with automatic LIVE window handling:
 * - If stripeMode is "live" and window exists and now outside -> revert to test + persist.
 */
async function getCheckoutSettingsAuto(now = new Date()) {
  let s = await getCheckoutSettingsRaw();
  let changed = false;

  if (s.stripeMode === "live") {
    const start = s.liveStart ? new Date(s.liveStart) : null;
    const end = s.liveEnd ? new Date(s.liveEnd) : null;
    const hasWindow = !!(start || end);

    const tooEarly = start && now < start;
    const tooLate = end && now > end;

    if (hasWindow && (tooEarly || tooLate)) {
      s = { ...s, stripeMode: "test" };
      changed = true;
    }
  }

  if (changed) await kv.set(CHECKOUT_SETTINGS_KEY, s);
  return s;
}

/**
 * Compute effective channel stamped onto each order:
 * Returns: "test" | "live_test" | "live"
 */
async function getEffectiveOrderChannel(now = new Date()) {
  const s = await getCheckoutSettingsAuto(now);

  let mode = s.stripeMode;
  if (mode !== "live" && mode !== "live_test" && mode !== "test") mode = "test";

  if (mode === "live") {
    const start = s.liveStart ? new Date(s.liveStart) : null;
    const end = s.liveEnd ? new Date(s.liveEnd) : null;
    const hasWindow = !!(start || end);

    const tooEarly = start && now < start;
    const tooLate = end && now > end;

    if (hasWindow && (tooEarly || tooLate)) mode = "test";
  }

  return mode;
}


export {
  getStripe,
  getStripePublishableKey,
  getCheckoutSettingsRaw,
  saveCheckoutSettings,
  getCheckoutSettingsAuto,
  getEffectiveOrderChannel,
};
