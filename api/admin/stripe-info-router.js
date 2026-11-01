// /api/admin/stripe-info-router.js
import {
  REQ_OK,
  REQ_ERR,
  getStripe,
  getStripePublishableKey,
  getEffectiveOrderChannel,
} from "./core.js";

// Stripe session IDs include cs_test_ or cs_live_
function inferStripeEnvFromCheckoutSessionId(id) {
  const s = String(id || "").trim();
  if (s.startsWith("cs_live_")) return "live";
  if (s.startsWith("cs_test_")) return "test";
  return "";
}

export async function handleStripeInfoRoute(req, res, ctx = {}) {
  const { url, type, requestId, errResponse, requireAdminAuth } = ctx;

  if (req.method !== "GET") return false;

  if (type === "stripe_pubkey" || type === "stripe_pk") {
    const mode = await getEffectiveOrderChannel().catch(() => "test");
    return REQ_OK(res, {
      requestId,
      publishableKey: getStripePublishableKey(mode),
      mode,
    });
  }

  if (type === "checkout_session") {
    if (!(await requireAdminAuth(req, res))) return true;
    const id = String(url.searchParams.get("id") || "").trim();
    if (!id) return REQ_ERR(res, 400, "missing-id", { requestId });

    const inferred = inferStripeEnvFromCheckoutSessionId(id);

    let primaryEnv = inferred;
    if (!primaryEnv) {
      const eff = await getEffectiveOrderChannel().catch(() => "test");
      primaryEnv = eff === "live" || eff === "live_test" ? "live" : "test";
    }
    const fallbackEnv = primaryEnv === "live" ? "test" : "live";

    const stripePrimary = await getStripe(primaryEnv);
    const stripeFallback = await getStripe(fallbackEnv);

    const tryRetrieve = async (stripeClient) => {
      if (!stripeClient) return null;
      return stripeClient.checkout.sessions.retrieve(id, {
        expand: ["payment_intent"],
      });
    };

    let s = null;
    let usedEnv = primaryEnv;

    try {
      s = await tryRetrieve(stripePrimary);
      usedEnv = primaryEnv;
    } catch {}

    if (!s) {
      try {
        s = await tryRetrieve(stripeFallback);
        usedEnv = fallbackEnv;
      } catch {}
    }

    if (!s) {
      return REQ_ERR(res, 404, "checkout-session-not-found", {
        requestId,
        id,
      });
    }

    return REQ_OK(res, {
      requestId,
      env: usedEnv,
      id: s.id,
      amount_total: s.amount_total,
      currency: s.currency,
      customer_details: s.customer_details || {},
      payment_intent:
        typeof s.payment_intent === "string"
          ? s.payment_intent
          : s.payment_intent?.id,
    });
  }

  return false;
}
