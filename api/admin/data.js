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

function extractMealChoice(itemName) {
  const s = String(itemName || "").trim();
  // Common pattern: "Banquet Name (Meal Choice)"
  // We only treat the LAST parenthetical group as a meal choice.
  const m = s.match(/^(.*)\s\(([^()]{2,})\)\s*$/);
  if (!m) return { baseName: s, mealChoice: "" };
  return { baseName: m[1].trim(), mealChoice: m[2].trim() };
}

function normalizeLine(l) {
  const meta = (l && l.meta) || {};
  const itemName = String(l?.itemName || l?.name || "").trim();
  const { baseName, mealChoice } = extractMealChoice(itemName);

  return {
    itemId: String(l?.itemId || "").trim(),
    itemType: String(l?.itemType || "").trim(), // banquet | addon | catalog | supplies | charity | etc
    itemName,
    itemNameBase: baseName,
    mealChoice: String(meta.mealChoice || meta.meal || meta.mealType || mealChoice || "").trim(),

    qty: Number(l?.qty || 0) || 0,
    unitPrice: l?.unitPrice ?? 0,
    priceMode: String(l?.priceMode || "").trim(),
    bundleQty: l?.bundleQty ?? null,
    bundleTotalCents: l?.bundleTotalCents ?? null,

    // Attendee assignment + meal/dietary context
    attendeeId: String(l?.attendeeId || "").trim(),
    attendeeName: String(meta.attendeeName || "").trim(),
    attendeeTitle: String(meta.attendeeTitle || "").trim(),
    attendeePhone: String(meta.attendeePhone || "").trim(),
    attendeeEmail: String(meta.attendeeEmail || "").trim(),
    attendeeNotes: String(meta.attendeeNotes || "").trim(),
    dietaryNote: String(meta.dietaryNote || "").trim(),

    // Optional: court / court# often lives in notes today (keep raw notes too)
    court: String(meta.court || "").trim(),
    courtNumber: String(meta.courtNumber || meta.courtNo || meta.courtNum || "").trim(),

    // Item-level note (e.g., corsage custom text)
    itemNote: String(meta.itemNote || "").trim(),

    // Address if present (some items use purchaser, but we preserve anything passed)
    attendeeAddr1: String(meta.attendeeAddr1 || "").trim(),
    attendeeAddr2: String(meta.attendeeAddr2 || "").trim(),
    attendeeCity: String(meta.attendeeCity || "").trim(),
    attendeeState: String(meta.attendeeState || "").trim(),
    attendeePostal: String(meta.attendeePostal || "").trim(),
    attendeeCountry: String(meta.attendeeCountry || "").trim(),
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