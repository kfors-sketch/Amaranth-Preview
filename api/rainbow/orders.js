import { randomUUID } from "node:crypto";
import { kv } from "@vercel/kv";
import { getStripe } from "../admin/stripe-mode.js";
import { requireAdminFromHeaders } from "../admin/security.js";
import { calculateProcessingFeeCents } from "../admin/checkout-pricing.js";
import { isInternationalOrder, computeInternationalFeeCents, buildInternationalFeeLineItem } from "../admin/fees.js";
import { scope, recordsKey, pendingKey, isSubmissionId, isTestSession, saveRainbowPayment } from "./payment.js";

const defaults = [
  { id: "shirt", name: "Rainbow T-shirt", detail: "Sample crewneck • adult S–2XL", cents: 1800, options: ["S", "M", "L", "XL", "2XL"] },
  { id: "pin", name: "Rainbow lapel pin", detail: "Sample commemorative pin", cents: 600, options: ["Standard"] },
  { id: "tote", name: "Rainbow tote bag", detail: "Sample reusable canvas tote", cents: 1200, options: ["Standard"] },
  { id: "lunch", name: "Annual Session lunch", detail: "Sample banquet", cents: 1500, type: "banquet" },
].map(entry => ({ type: "shop", active: true, ...entry }));
const catalogKey = "rainbow:ordering:v1:catalog";
const registrationCents = 1000;
const membershipLabels = {
  parent: "Parent", youth: "Youth", youth_leader: "Youth Leader",
  voting: "Voting", non_voting: "Non-Voting",
};

const pages = { store: "/rainbow/store.html", session: "/rainbow/annual-session.html" };
const contactFields = [
  ["name", "full name"], ["title", "title"], ["email", "email"], ["phone", "phone"],
  ["address1", "address line 1"], ["address2", "address line 2"], ["city", "city"],
  ["state", "state or province"], ["postal", "postal code"], ["country", "country"],
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function invalid(message) {
  throw Object.assign(new Error(message), { input: true });
}

function field(value, label, max = 80, required = true) {
  const clean = typeof value === "string" ? value.trim() : "";
  if ((required && !clean) || clean.length > max) invalid("Check " + label + ".");
  return clean;
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    invalid("Send a JSON request.");
  }
  let body = req.body;
  if (body == null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16000) invalid("Submission is too large.");
      chunks.push(Buffer.from(chunk));
    }
    body = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > 16000) invalid("Submission is too large.");
    try { body = JSON.parse(body); } catch { invalid("Invalid request."); }
  }
  if (!body || Array.isArray(body) || typeof body !== "object") invalid("Invalid request.");
  return body;
}

function contactInfo(input) {
  const contact = Object.fromEntries(contactFields.map(([key, label]) =>
    [key, field(input?.[key], "the sample " + label, 120, key !== "address2")]));
  contact.email = contact.email.toLowerCase();
  if (!/^[a-z0-9._+-]+@example\.(com|org|net)$/.test(contact.email)) {
    invalid("Use a sample email such as tester@example.com.");
  }
  contact.country = contact.country.toUpperCase();
  if (/^(USA|U\.S\.A?\.?|UNITED STATES(?: OF AMERICA)?)$/.test(contact.country)) contact.country = "US";
  if (!/^[A-Z]{2}$/.test(contact.country)) invalid("Use a two-letter country code, such as US or CA.");
  return contact;
}

async function loadCatalog(store) {
  const entries = new Map(defaults.map(entry => [entry.id, entry]));
  for (const value of Object.values(await store.hgetall(catalogKey) || {})) {
    const entry = typeof value === "string" ? JSON.parse(value) : value;
    entries.set(entry.id, entry);
  }
  return [...entries.values()];
}

function catalogEntry(body, existing) {
  const { type, active, cents } = body;
  if (!["shop", "banquet", "event"].includes(type) || typeof active !== "boolean" ||
      !Number.isInteger(cents) || cents < (type === "shop" ? 50 : 0) || cents > 100000) {
    invalid("Check the category, visibility, and price. Shop items must cost at least $0.50.");
  }
  if (existing && existing.type !== type) invalid("The category of an existing item cannot be changed.");
  const name = field(body.name, "the item name");
  const detail = field(body.detail, "the description", 240, false);
  const options = type === "shop" && Array.isArray(body.options) && body.options.length
    ? [...new Set(body.options.map(option => field(option, "each option", 30)))] : ["Standard"];
  if (options.length > 12) invalid("Enter up to 12 options.");
  return { id: existing?.id || randomUUID(), type, active, cents, name, detail, options };
}

function buildSubmission(body, catalog) {
  const id = field(body.id, "the confirmation ID", 36);
  if (!isSubmissionId(id)) invalid("Invalid confirmation ID.");
  const purchaser = contactInfo(body.purchaser);
  if (!Object.hasOwn(pages, body.kind)) invalid("Choose a submission type.");

  const base = { id, kind: body.kind, purchaser };
  if (body.kind === "store") {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) invalid("Add sample merchandise to your cart.");
    const seen = new Set();
    const items = body.items.map((item) => {
      const { id: productId, option, quantity } = item || {};
      const product = catalog.find(entry => entry.type === "shop" && entry.active && entry.id === productId);
      if (!product || !product.options.includes(option) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        invalid("Check the item, size, and quantity.");
      }
      const variant = productId + ":" + option;
      if (seen.has(variant)) invalid("Combine quantities for matching items.");
      seen.add(variant);
      return { name: product.name, option, quantity, cents: product.cents };
    });
    return { ...base, items, totalCents: items.reduce((sum, item) => sum + item.cents * item.quantity, 0) };
  }

  if (!Array.isArray(body.attendees) || !body.attendees.length || body.attendees.length > 6) invalid("Enter one to six sample attendees.");
  const attendees = body.attendees.map((attendee) => {
    const contact = contactInfo(attendee);
    const assembly = field(attendee.assembly, "the sample assembly name");
    const assemblyNumber = field(attendee.assemblyNumber, "the sample assembly number", 30);
    if (!["parent", "youth", "youth_leader"].includes(attendee.memberType)) {
      invalid("Check each attendee’s registration options.");
    }
    const notes = field(attendee.notes, "attendee notes", 300, false);
    const selected = attendee.events ?? (attendee.lunch === true ? ["lunch"] : []);
    if (!Array.isArray(selected) || selected.length > 40 || new Set(selected).size !== selected.length) {
      invalid("Check the selected Annual Session events.");
    }
    const events = selected.map(id => {
      const entry = catalog.find(item => item.id === id && item.type !== "shop" && item.active);
      if (!entry) invalid("An event is no longer available. Reload the page to see current choices.");
      return { id, name: entry.name, type: entry.type, cents: entry.cents };
    });
    return { ...contact, assembly, assemblyNumber, memberType: attendee.memberType, notes, events };
  });
  return {
    ...base, attendees,
    totalCents: attendees.reduce((sum, attendee) => sum + registrationCents + attendee.events.reduce((total, event) => total + event.cents, 0), 0),
  };
}

function lineItems(submission) {
  const price = (name, cents, quantity) => ({
    price_data: { currency: "usd", unit_amount: cents, product_data: { name } },
    quantity,
  });
  if (submission.kind === "store") {
    return submission.items.map(item => price(item.name + " (" + item.option + ")", item.cents, item.quantity));
  }
  const events = new Map();
  for (const attendee of submission.attendees) {
    for (const event of attendee.events) {
      if (event.cents === 0) continue;
      const item = events.get(event.id) || { ...event, quantity: 0 };
      item.quantity += 1;
      events.set(event.id, item);
    }
  }
  return [price("Annual Session registration", registrationCents, submission.attendees.length),
    ...[...events.values()].map(event => price(event.name, event.cents, event.quantity))];
}

function withFees(submission, env) {
  const subtotalCents = submission.totalCents;
  const processingFee = calculateProcessingFeeCents(
    subtotalCents, Number(env.STRIPE_FEE_PERCENT || 2.9), Number(env.STRIPE_FEE_FLAT || 0.30));
  const accountCountry = (env.STRIPE_ACCOUNT_COUNTRY || "US").trim();
  const internationalFee = isInternationalOrder(submission.purchaser.country, accountCountry)
    ? computeInternationalFeeCents(subtotalCents) : 0;
  return { ...submission, subtotalCents, processingFee, internationalFee,
    totalCents: subtotalCents + processingFee + internationalFee };
}

function returnPage(req, env) {
  const hosts = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
    .filter(host => /^[a-z0-9.-]+\.vercel\.app$/i.test(host || ""));
  if (env.SITE_BASE_URL) {
    try {
      const site = new URL(env.SITE_BASE_URL);
      if (site.protocol === "https:") hosts.push(site.host);
    } catch {}
  }
  const host = hosts.includes(req.headers.host) ? req.headers.host : hosts[0];
  return host ? "https://" + host : "";
}

function csv(records) {
  const cell = (value) => {
    const text = String(value ?? "");
    const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const row = (values) => values.map(cell).join(",");
  const rows = [row(["Confirmation", "Type", "Submitted UTC", "Test result", "Details",
    ...contactFields.map(([, label]) => "Purchaser " + label), "Subtotal USD", "Processing fee USD",
    "International fee USD", "Total USD", ...contactFields.map(([, label]) => "Attendee " + label),
    "Assembly", "Assembly #", "Membership", "Banquets and events", "Dietary notes"])];
  const amount = cents => (cents / 100).toFixed(2);
  for (const record of records) {
    const details = record.kind === "store"
      ? record.items.map(item => item.quantity + " × " + item.name + " (" + item.option + ")").join(" | ")
      : "Annual Session";
    const order = [record.id, record.kind, record.createdAt, record.status, details,
      ...contactFields.map(([key]) => record.purchaser[key]), amount(record.subtotalCents),
      amount(record.processingFee), amount(record.internationalFee), amount(record.totalCents)];
    for (const attendee of record.attendees || [{}]) {
      rows.push(row([...order, ...contactFields.map(([key]) => attendee[key]), attendee.assembly,
        attendee.assemblyNumber, membershipLabels[attendee.memberType] ?? attendee.memberType, attendee.events?.map(event => event.name).join(" | ") ?? (attendee.lunch ? "Annual Session lunch" : ""), attendee.notes]));
    }
  }
  return rows.join("\r\n") + "\r\n";
}

export function createHandler({
  store = kv, env = process.env, getTestStripe = () => getStripe("test"),
  authorize = requireAdminFromHeaders,
} = {}) {
  return async function rainbow(req, res) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url, "http://localhost");
    const action = url.searchParams.get("action");
    const reportKind = url.searchParams.get("kind");
    try {
      if (req.method === "GET" && action === "catalog") {
        const entries = (await loadCatalog(store)).filter(entry => entry.active);
        return json(res, 200, { products: entries.filter(entry => entry.type === "shop"),
          events: entries.filter(entry => entry.type !== "shop"), registrationCents,
          checkoutEnabled: env.RAINBOW_TEST_ENABLED === "1" });
      }
      if (action === "manage-catalog" && ["GET", "POST"].includes(req.method)) {
        if (!(await authorize(req.headers)).ok) return json(res, 401, { error: "Sign in with your Grand admin password." });
        const entries = await loadCatalog(store);
        if (req.method === "GET") return json(res, 200, entries);
        const body = await readBody(req);
        const existing = entries.find(entry => entry.id === body.id);
        if (body.id && !existing) return json(res, 404, { error: "This catalog item could not be found." });
        if (!existing && entries.length >= 80) invalid("The catalog can hold up to 80 entries.");
        const entry = catalogEntry(body, existing);
        await store.hset(catalogKey, { [entry.id]: JSON.stringify(entry) });
        return json(res, 200, entry);
      }
      if (req.method === "POST" && ["checkout", "confirm"].includes(action)) {
        const body = await readBody(req);
        if (!/^(sk|rk)_test_/.test((env.STRIPE_SECRET_KEY_TEST || "").trim())) {
          return json(res, 503, { error: "Grand’s Stripe test key is missing from this Vercel preview." });
        }
        const stripe = await getTestStripe();
        if (action === "confirm") {
          if (!isTestSession(body.sessionId)) invalid("Invalid Stripe test session.");
          const session = await stripe.checkout.sessions.retrieve(body.sessionId);
          const record = await saveRainbowPayment(session, store);
          if (!record) return json(res, 409, { error: "No paid Rainbow test submission matches this checkout." });
          return json(res, 200, { id: record.id, totalCents: record.totalCents });
        }
        if (env.RAINBOW_TEST_ENABLED !== "1") {
          return json(res, 503, { error: "Rainbow test checkout is turned off." });
        }
        if (!isSubmissionId(body.id)) invalid("Invalid confirmation ID.");
        const draftKey = pendingKey(body.id);
        const origin = returnPage(req, env);
        if (!origin) return json(res, 503, { error: "Open Rainbow on its Grand site URL to test Stripe." });
        const signature = JSON.stringify(body);
        let saved = await store.get(draftKey);
        if (!saved) {
          const submission = withFees(buildSubmission(body, await loadCatalog(store)), env);
          if (body.expectedSubtotal != null && body.expectedSubtotal !== submission.subtotalCents) {
            return json(res, 409, { error: "Prices have changed. Reload the page before checking out." });
          }
          const draft = { submission, signature, base: origin + pages[submission.kind], startedAt: Date.now() };
          const claimed = await store.set(draftKey, draft, { nx: true, ex: 7 * 24 * 60 * 60 });
          saved = claimed ? draft : await store.get(draftKey);
        }
        if (!saved || saved.signature !== signature || Date.now() - saved.startedAt > 23 * 60 * 60 * 1000) {
          return json(res, 409, { error: "Start a new Rainbow checkout to continue." });
        }
        const { submission } = saved;
        const metadata = { site_scope: scope, rainbow_submission: submission.id };
        const lines = lineItems(submission);
        if (submission.processingFee > 0) lines.push({
          price_data: { currency: "usd", unit_amount: submission.processingFee,
            product_data: { name: "Online Processing Fee" } }, quantity: 1,
        });
        if (submission.internationalFee > 0) lines.push(buildInternationalFeeLineItem(submission.internationalFee));
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          client_reference_id: submission.id,
          customer_email: submission.purchaser.email,
          line_items: lines,
          success_url: saved.base + "?stripe_session={CHECKOUT_SESSION_ID}",
          cancel_url: saved.base + "?stripe_cancel=" + submission.kind,
          metadata,
          payment_intent_data: { metadata },
        }, { idempotencyKey: scope + ":" + submission.id });
        if (session.livemode !== false || !isTestSession(session.id) ||
            !session.url?.startsWith("https://checkout.stripe.com/")) {
          return json(res, 409, { error: "This test checkout is unavailable. Start a new checkout." });
        }
        return json(res, 200, { url: session.url });
      }
      if (req.method === "GET" && ["report", "csv"].includes(action)) {
        if (!(await authorize(req.headers)).ok) {
          return json(res, 401, { error: "Sign in with your Grand admin password." });
        }
        if (!Object.hasOwn(pages, reportKind)) return json(res, 400, { error: "Choose a Rainbow report." });
        const entries = Object.values(await store.hgetall(recordsKey) || {});
        const records = entries.map(value => typeof value === "string" ? JSON.parse(value) : value)
          .filter(record => record.kind === reportKind)
          .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
        if (action === "report") return json(res, 200, records);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="rainbow-' + (reportKind === "store" ? "orders" : "registrations") + '.csv"');
        return res.end(csv(records));
      }
      return json(res, 404, { error: "Page not found." });
    } catch (error) {
      if (error.input) return json(res, 400, { error: error.message });
      console.error("Rainbow preview operation failed:", error.name);
      return json(res, 503, { error: "Rainbow could not reach Stripe or test storage. Try again shortly." });
    }
  };
}

export default createHandler();
