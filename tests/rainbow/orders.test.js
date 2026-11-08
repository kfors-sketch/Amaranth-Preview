import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createHandler } from "../../api/rainbow/orders.js";
import { saveRainbowPayment } from "../../api/rainbow/payment.js";

test("Rainbow checkout is test-only and paid orders appear in separate Grand-admin reports", async (t) => {
  const env = { STRIPE_SECRET_KEY_TEST: "sk_test_mock", VERCEL_URL: "grand.vercel.app" };
  const drafts = new Map();
  const records = new Map();
  const sessions = new Map();
  const store = {
    set: async (key, value) => drafts.has(key) ? null : drafts.set(key, value),
    get: async key => drafts.get(key),
    hsetnx: async (_key, id, value) => records.has(id) ? 0 : records.set(id, value),
    hget: async (_key, id) => records.get(id),
    hgetall: async () => Object.fromEntries(records),
  };
  const stripe = { checkout: { sessions: {
    create: async (params, options) => {
      const id = "cs_test_" + params.client_reference_id.replaceAll("-", "");
      assert.match(options.idempotencyKey, /pa-rainbow-test:/);
      if (!sessions.has(id)) {
        sessions.set(id, { ...params, id, livemode: false, status: "open", payment_status: "unpaid",
          currency: "usd", url: "https://checkout.stripe.com/c/pay/" + id,
          amount_total: params.line_items.reduce((sum, line) => sum + line.quantity * line.price_data.unit_amount, 0) });
      }
      return sessions.get(id);
    },
    retrieve: async id => sessions.get(id),
  } } };
  const server = createServer(createHandler({ store, env, getTestStripe: async () => stripe,
    authorize: async headers => ({ ok: headers.authorization === "Bearer grand-admin-test" }) }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port + "/api/rainbow/orders";
  const get = (action, kind, admin = false) => fetch(url + "?action=" + action + "&kind=" + kind, {
    headers: admin ? { Authorization: "Bearer grand-admin-test" } : {},
  });
  const post = (action, body) => fetch(url + "?action=" + action, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const purchaser = { name: "=Sample Person", title: "Sample Title", email: "tester@example.com",
    phone: "717-555-0100", address1: "123 Sample Street", city: "Sample City", state: "PA", postal: "17000", country: "US" };
  const order = { id: randomUUID(), kind: "store", purchaser, totalCents: 1,
    items: [{ id: "shirt", option: "M", quantity: 2 }, { id: "pin", option: "Standard", quantity: 1 }] };
  assert.equal((await post("checkout", order)).status, 503);
  env.RAINBOW_TEST_ENABLED = "1";
  env.STRIPE_SECRET_KEY_TEST = "sk_live_mock";
  assert.equal((await post("checkout", order)).status, 503);
  env.STRIPE_SECRET_KEY_TEST = "sk_test_mock";
  assert.equal((await post("checkout", { ...order, purchaser: { ...purchaser, address1: "" } })).status, 400);
  assert.equal((await post("checkout", order)).status, 200);
  assert.equal((await post("checkout", order)).status, 200);
  assert.equal(sessions.size, 1);
  const [purchase] = sessions.values();
  assert.match(purchase.success_url, /\/rainbow\/store\.html\?stripe_session=/);
  assert.equal(purchase.amount_total, 4357);
  assert.equal((await post("confirm", { sessionId: purchase.id })).status, 409);
  purchase.status = "complete";
  purchase.payment_status = "paid";
  assert.equal(await saveRainbowPayment({ ...purchase, amount_total: 1 }, store), null);
  assert.equal((await saveRainbowPayment(purchase, store)).purchaser.address1, purchaser.address1);
  assert.equal((await post("confirm", { sessionId: purchase.id })).status, 200);
  assert.equal(records.size, 1);

  const registration = { id: randomUUID(), kind: "session", purchaser: { ...purchaser, country: "CA" },
    attendees: [{ ...purchaser, assembly: "Sample Assembly", assemblyNumber: "1", memberType: "voting",
      lunch: true, notes: "Sample dietary note" }] };
  assert.equal((await post("checkout", registration)).status, 200);
  const session = [...sessions.values()].at(-1);
  assert.match(session.success_url, /\/rainbow\/annual-session\.html\?stripe_session=/);
  assert.equal(session.line_items.at(-1).price_data.unit_amount, 75);
  session.status = "complete";
  session.payment_status = "paid";
  assert.equal((await post("confirm", { sessionId: session.id })).status, 200);
  assert.equal((await get("report", "store")).status, 401);
  assert.equal((await get("csv", "session")).status, 401);
  const orders = await (await get("report", "store", true)).json();
  assert.deepEqual(orders.map(record => record.id), [order.id]);
  const registrations = await (await get("report", "session", true)).json();
  assert.deepEqual(registrations.map(record => record.id), [registration.id]);
  assert.match(await (await get("csv", "session", true)).text(), /Sample dietary note/);
  assert.match(await (await get("csv", "store", true)).text(), /"'=Sample Person"/);
});
