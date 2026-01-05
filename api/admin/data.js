// /api/admin/data.js

import { kvSetSafe, kvGetSafe, toCentsAuto } from "./core.js";

// Keyed by Stripe checkout session id (cs_...)
export function draftKeyForSessionId(sessionId) {
  return `checkout_draft:${String(sessionId || "").trim()}`;
}

function cleanStr(v) {
  return String(v ?? "").trim();
}

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function normalizePurchaser(p) {
  const x = safeObj(p);
  return {
    name: cleanStr(x.name),
    email: cleanStr(x.email).toLowerCase(),
    phone: cleanStr(x.phone),
    title: cleanStr(x.title),

    address1: cleanStr(x.address1),
    address2: cleanStr(x.address2),
    city: cleanStr(x.city),
    state: cleanStr(x.state),
    postal: cleanStr(x.postal),
    country: cleanStr(x.country || "US").toUpperCase(),
  };
}

function normalizeMeta(m) {
  const x = safeObj(m);
  // Keep your known metadata fields stable (don’t let random junk explode row exports)
  return {
    attendeeName: cleanStr(x.attendeeName),
    attendeeTitle: cleanStr(x.attendeeTitle),
    attendeePhone: cleanStr(x.attendeePhone),
    attendeeEmail: cleanStr(x.attendeeEmail),
    attendeeNotes: cleanStr(x.attendeeNotes),
    dietaryNote: cleanStr(x.dietaryNote),

    votingStatus: cleanStr(x.votingStatus || x.voting_status || x.votingType || x.voting_type || x.voting),
    isVoting: x.isVoting === true ? true : x.isVoting === false ? false : cleanStr(x.isVoting),

    itemNote: cleanStr(x.itemNote || x.item_note || x.notes || x.note || x.message),

    corsageChoice: cleanStr(x.corsageChoice || x.corsage_choice || x.corsageType || x.corsage_type || x.choice || x.selection || x.style || x.color),
    corsageWear: cleanStr(x.corsageWear || x.corsage_wear || x.wear || x.wearStyle || x.wear_style || x.attachment),
  };
}

function normalizeLine(l) {
  const x = safeObj(l);

  const qty = Math.max(1, Number(x.qty || 1));
  const unitCents = toCentsAuto(x.unitPrice || 0);

  return {
    // Identity/routing
    itemId: cleanStr(x.itemId),
    itemType: cleanStr(x.itemType), // banquet/addon/catalog/fee/etc.

    // Presentation
    itemName: cleanStr(x.itemName || "Item"),

    // Pricing
    qty,
    unitPriceCents: unitCents,

    // Assignment
    attendeeId: cleanStr(x.attendeeId),

    // Options/notes
    meta: normalizeMeta(x.meta),

    // Bundle support (if you use it)
    priceMode: cleanStr(x.priceMode).toLowerCase(),
    bundleQty: x.bundleQty != null ? String(x.bundleQty) : "",
    bundleTotalCents: x.bundleTotalCents != null ? String(toCentsAuto(x.bundleTotalCents)) : "",
  };
}

/**
 * Build a canonical “draft” that represents what the buyer intended to purchase,
 * independent of Stripe’s product name tricks.
 */
export function buildCheckoutDraft({ requestId, orderChannel, purchaser, lines, fees }) {
  const nowIso = new Date().toISOString();
  const normLines = Array.isArray(lines) ? lines.map(normalizeLine) : [];

  return {
    v: 1,
    requestId: cleanStr(requestId),
    createdAt: nowIso,

    orderChannel: cleanStr(orderChannel || "test"),
    purchaser: normalizePurchaser(purchaser),

    fees: safeObj(fees),

    lineCount: normLines.length,
    lines: normLines,
  };
}

export async function saveCheckoutDraft(sessionId, draft) {
  const key = draftKeyForSessionId(sessionId);
  await kvSetSafe(key, draft);
  return { ok: true, key };
}

export async function getCheckoutDraft(sessionId) {
  const key = draftKeyForSessionId(sessionId);
  const draft = await kvGetSafe(key, null);
  return { ok: !!draft, key, draft };
}