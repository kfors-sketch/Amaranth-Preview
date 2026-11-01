import { kv } from "@vercel/kv";
import crypto from "crypto";
// /api/admin/transportation.js
// Transportation report helpers kept separate so router.js/core.js do not grow.

const TRANSPORT_CHUNK_PREFIX = "transportJson";
const TRANSPORT_CHUNK_COUNT = 8;
const TRANSPORT_CHUNK_SIZE = 450; // Stripe metadata value limit is 500 chars; leave margin.

function cleanString(v) {
  return String(v ?? "").trim();
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = cleanString(v).toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function safeJsonParse(text) {
  try {
    if (!text) return null;
    const parsed = JSON.parse(String(text));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isTransportationMeta(meta = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  if (cleanString(m.category).toLowerCase() === "transportation") return true;
  if (cleanString(m.itemType).toLowerCase() === "transportation") return true;
  if (m.transportation && typeof m.transportation === "object") return true;
  for (let i = 1; i <= TRANSPORT_CHUNK_COUNT; i++) {
    if (m[`${TRANSPORT_CHUNK_PREFIX}${i}`]) return true;
  }
  return false;
}

export function buildTransportationMetadata(transportation) {
  const out = {};
  if (!transportation || typeof transportation !== "object") return out;

  const json = JSON.stringify(transportation);
  out.category = "transportation";
  out.passengerCount = String(transportation.passengerCount || transportation.passengers?.length || 0);
  out.pickupNeeded = transportation?.pickup?.needed ? "true" : "false";
  out.dropoffNeeded = transportation?.dropoff?.needed ? "true" : "false";
  out.paymentMode = cleanString(transportation.paymentMode || "");
  out.paymentBasis = cleanString(transportation.paymentBasis || "");

  for (let i = 0; i < TRANSPORT_CHUNK_COUNT; i++) {
    const chunk = json.slice(i * TRANSPORT_CHUNK_SIZE, (i + 1) * TRANSPORT_CHUNK_SIZE);
    if (chunk) out[`${TRANSPORT_CHUNK_PREFIX}${i + 1}`] = chunk;
  }
  return out;
}

export function extractTransportationFromMeta(meta = {}) {
  const m = meta && typeof meta === "object" ? meta : {};

  if (m.transportation && typeof m.transportation === "object") {
    return normalizeTransportation(m.transportation, m);
  }

  let combined = "";
  for (let i = 1; i <= TRANSPORT_CHUNK_COUNT; i++) {
    combined += cleanString(m[`${TRANSPORT_CHUNK_PREFIX}${i}`]);
  }

  const parsed = safeJsonParse(combined);
  if (parsed) return normalizeTransportation(parsed, m);

  if (!isTransportationMeta(m)) return null;

  // Fallback for partial/older rows that only have summary fields.
  return normalizeTransportation({
    passengerCount: Number(m.passengerCount || 0) || 0,
    paymentMode: cleanString(m.paymentMode || ""),
    paymentBasis: cleanString(m.paymentBasis || ""),
    pickup: { needed: toBool(m.pickupNeeded) },
    dropoff: { needed: toBool(m.dropoffNeeded) },
    passengers: [],
  }, m);
}

export function normalizeTransportation(raw = {}, meta = {}) {
  const t = raw && typeof raw === "object" ? raw : {};
  const passengers = Array.isArray(t.passengers) ? t.passengers.map((p, idx) => ({
    number: Number(p?.number || idx + 1),
    name: cleanString(p?.name),
    phone: cleanString(p?.phone),
    email: cleanString(p?.email),
  })) : [];

  const pickup = t.pickup && typeof t.pickup === "object" ? t.pickup : {};
  const dropoff = t.dropoff && typeof t.dropoff === "object" ? t.dropoff : {};

  return {
    passengerCount: Number(t.passengerCount || passengers.length || meta.passengerCount || 0) || 0,
    passengers,
    pickup: {
      needed: toBool(pickup.needed ?? meta.pickupNeeded),
      airport: cleanString(pickup.airport),
      airline: cleanString(pickup.airline),
      flight: cleanString(pickup.flight),
      datetime: cleanString(pickup.datetime),
      notes: cleanString(pickup.notes),
    },
    dropoff: {
      needed: toBool(dropoff.needed ?? meta.dropoffNeeded),
      airport: cleanString(dropoff.airport),
      airline: cleanString(dropoff.airline),
      flight: cleanString(dropoff.flight),
      datetime: cleanString(dropoff.datetime),
      notes: cleanString(dropoff.notes),
    },
    paymentMode: cleanString(t.paymentMode || meta.paymentMode),
    paymentBasis: cleanString(t.paymentBasis || meta.paymentBasis),
    donationAmount: Number(t.donationAmount || 0) || 0,
  };
}

export function transportationNotes(t) {
  if (!t) return "";
  const bits = [];
  bits.push(`${t.passengerCount || t.passengers?.length || 0} passenger(s)`);
  if (t.pickup?.needed) bits.push("Pickup needed");
  if (t.dropoff?.needed) bits.push("Drop-off needed");
  if (t.paymentMode) bits.push(`Payment mode: ${t.paymentMode}`);
  return bits.filter(Boolean).join("; ");
}

export function transportationRowFields(t) {
  if (!t) return {};
  const passengers = Array.isArray(t.passengers) ? t.passengers : [];
  const names = passengers.map(p => p.name).filter(Boolean).join("; ");
  const phones = passengers.map(p => p.phone).filter(Boolean).join("; ");
  const emails = passengers.map(p => p.email).filter(Boolean).join("; ");

  return {
    passenger_count: t.passengerCount || passengers.length || 0,
    passenger_names: names,
    passenger_phones: phones,
    passenger_emails: emails,
    pickup_needed: t.pickup?.needed ? "yes" : "no",
    pickup_airport: t.pickup?.airport || "",
    pickup_airline: t.pickup?.airline || "",
    pickup_flight: t.pickup?.flight || "",
    pickup_datetime: t.pickup?.datetime || "",
    pickup_notes: t.pickup?.notes || "",
    dropoff_needed: t.dropoff?.needed ? "yes" : "no",
    dropoff_airport: t.dropoff?.airport || "",
    dropoff_airline: t.dropoff?.airline || "",
    dropoff_flight: t.dropoff?.flight || "",
    dropoff_datetime: t.dropoff?.datetime || "",
    dropoff_notes: t.dropoff?.notes || "",
    transportation_payment_mode: t.paymentMode || "",
    transportation_payment_basis: t.paymentBasis || "",
  };
}


// -----------------------------------------------------------------------------
// Stripe-safe transportation storage
// -----------------------------------------------------------------------------
// Full passenger/flight data can exceed Stripe metadata limits. We store the full
// object in KV before checkout and send only this short reference through Stripe.
const TRANSPORT_REF_PREFIX = "transport:";

function makeTransportRef() {
  return "tr_" + crypto.randomBytes(12).toString("hex");
}

export async function storeTransportationPayload(transportation, context = {}) {
  if (!transportation || typeof transportation !== "object") return {};

  const ref = makeTransportRef();
  const payload = {
    ref,
    createdAt: new Date().toISOString(),
    context: context && typeof context === "object" ? context : {},
    transportation,
  };

  await kv.set(TRANSPORT_REF_PREFIX + ref, payload);

  return {
    category: "transportation",
    transportationRef: ref,
    passengerCount: String(transportation.passengerCount || transportation.passengers?.length || 0),
    pickupNeeded: transportation?.pickup?.needed ? "true" : "false",
    dropoffNeeded: transportation?.dropoff?.needed ? "true" : "false",
    paymentMode: cleanString(transportation.paymentMode || ""),
    paymentBasis: cleanString(transportation.paymentBasis || ""),
  };
}

export async function loadTransportationPayload(ref) {
  const key = String(ref || "").trim();
  if (!key) return null;
  try {
    const stored = await kv.get(TRANSPORT_REF_PREFIX + key);
    if (!stored || typeof stored !== "object") return null;
    const obj = stored.transportation && typeof stored.transportation === "object"
      ? stored.transportation
      : null;
    return obj ? normalizeTransportation(obj, { transportationRef: key }) : null;
  } catch {
    return null;
  }
}

export async function hydrateTransportationLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return lines || [];
  for (const line of lines) {
    const meta = line && line.meta && typeof line.meta === "object" ? line.meta : {};
    const ref = meta.transportationRef || meta.transportation_ref || "";
    if (!ref) continue;
    const full = await loadTransportationPayload(ref);
    if (full) {
      line.meta = { ...meta, transportation: full, transportationRef: ref };
    }
  }
  return lines;
}
