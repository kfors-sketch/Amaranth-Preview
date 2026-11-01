// /api/admin/webhook-router.js
import {
  REQ_OK,
  REQ_ERR,
  getStripe,
  saveOrderFromSession,
  applyRefundToOrder,
} from "./core.js";

export async function handleWebhookRoute(req, res, ctx = {}) {
  const {
    action,
    requestId,
    readRawBody,
    resolveModeFromSession,
    ensureOrderIntegrityMarkers,
    sendPostOrderEmails,
    errResponse,
  } = ctx;

  if (req.method !== "POST" || action !== "stripe_webhook") return false;

  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) return REQ_ERR(res, 400, "missing-signature", { requestId });

    const whsecLive = (process.env.STRIPE_WEBHOOK_SECRET_LIVE || "").trim();
    const whsecTest = (process.env.STRIPE_WEBHOOK_SECRET_TEST || "").trim();
    const whsecFallback = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

    const trySecrets = [whsecLive, whsecTest, whsecFallback].filter(Boolean);
    if (!trySecrets.length) {
      console.error("[webhook] no webhook secrets configured");
      return REQ_ERR(res, 500, "missing-webhook-secret", { requestId });
    }

    if (typeof readRawBody !== "function") {
      return REQ_ERR(res, 500, "webhook-reader-missing", { requestId });
    }

    const raw = await readRawBody(req);

    const stripeAny =
      (await getStripe("live")) ||
      (await getStripe("test")) ||
      (await getStripe());
    if (!stripeAny) return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

    let event = null;
    let verifiedWith = "";

    for (const secret of trySecrets) {
      try {
        event = stripeAny.webhooks.constructEvent(raw, sig, secret);
        verifiedWith =
          secret === whsecLive
            ? "live"
            : secret === whsecTest
            ? "test"
            : "fallback";
        break;
      } catch {}
    }

    if (!event) {
      console.error("Webhook signature verification failed with all known secrets");
      return REQ_ERR(res, 400, "invalid-signature", { requestId });
    }

    console.log(
      "[webhook] verifiedWith=",
      verifiedWith,
      "type=",
      event.type,
      "livemode=",
      !!event.livemode
    );

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        if (session?.payment_status !== "paid") break;
        const mode =
          typeof resolveModeFromSession === "function"
            ? await resolveModeFromSession(session)
            : "test";

        console.log("[webhook] checkout.session.completed", {
          requestId,
          sessionId: session?.id || null,
          mode,
          verifiedWith,
          livemode: !!event.livemode,
        });

        const order = await saveOrderFromSession(session.id || session, { mode });

        if (typeof ensureOrderIntegrityMarkers === "function") {
          await ensureOrderIntegrityMarkers(order, requestId);
        }

        if (typeof sendPostOrderEmails === "function") {
          await sendPostOrderEmails(order, requestId);
        }

        break;
      }

      case "charge.refunded": {
        const refund = event.data.object;
        await applyRefundToOrder(refund.charge, refund);
        break;
      }

      default:
        break;
    }

    return REQ_OK(res, { requestId, received: true, verifiedWith });
  } catch (e) {
    if (typeof errResponse === "function") {
      return errResponse(res, 500, "webhook-failed", req, e);
    }
    console.error("webhook-failed", e);
    return REQ_ERR(res, 500, "webhook-failed", { requestId });
  }
}
