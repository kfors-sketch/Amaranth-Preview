import { kv } from "@vercel/kv";

export const scope = "pa-rainbow-test";
export const recordsKey = "rainbow:ordering:v1:submissions";
export const pendingKey = (id) => "rainbow:ordering:v1:pending:" + id;
export const isSubmissionId = (id) => typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export const isTestSession = (id) => typeof id === "string" && /^cs_test_[A-Za-z0-9]+$/.test(id);

export async function saveRainbowPayment(session, store = kv) {
  const id = session.metadata?.rainbow_submission;
  if (session.livemode !== false || !isTestSession(session.id) || session.metadata?.site_scope !== scope ||
      !isSubmissionId(id) || session.client_reference_id !== id || session.mode !== "payment" ||
      session.status !== "complete" || session.payment_status !== "paid" || session.currency !== "usd") return null;

  const existing = await store.hget(recordsKey, id);
  if (existing) {
    const record = typeof existing === "string" ? JSON.parse(existing) : existing;
    return record.stripeSessionId === session.id ? record : null;
  }

  const pending = await store.get(pendingKey(id));
  if (!pending || session.amount_total !== pending.submission.totalCents) return null;
  const record = {
    ...pending.submission,
    status: "Stripe test paid",
    stripeSessionId: session.id,
    createdAt: new Date().toISOString(),
  };
  const inserted = await store.hsetnx(recordsKey, id, JSON.stringify(record));
  if (inserted) return record;
  const saved = await store.hget(recordsKey, id);
  const winner = typeof saved === "string" ? JSON.parse(saved) : saved;
  return winner?.stripeSessionId === session.id ? winner : null;
}
