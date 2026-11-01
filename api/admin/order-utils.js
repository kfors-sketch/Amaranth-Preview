// /api/admin/order-utils.js
import { getStripe } from "./stripe-mode.js";
import { cents, kvGetSafe, kvSaddSafe, kvSetSafe, kvSmembersSafe } from "./kv-utils.js";
import { sleep } from "./mail-utils.js";
import { attachImmutableOrderHash } from "./order-hash.js";
import { baseKey, normalizeKey, parseDateISO } from "./report-utils.js";
import { extractTransportationFromMeta, hydrateTransportationLines, isTransportationMeta, transportationNotes, transportationRowFields } from "./transportation.js";
import { extractTourFromMeta, isTourLine, tourNotes, tourRowFields } from "./tour-reports.js";

// Cached orders for the lifetime of a single lambda invocation
let _ordersCache = null;

// When admin tools patch stored orders, the warm lambda may still hold a cached
// copy. Expose a small helper so router.js can clear it after a patch.
export function clearOrdersCache() {
  _ordersCache = null;
}

// Load all orders with a few retries to be safer on cold starts
export async function loadAllOrdersWithRetry(options = {}) {
  const { retries = 4, delayMs = 500 } = options;
  if (Array.isArray(_ordersCache)) return _ordersCache;

  let lastOrders = [];

  for (let attempt = 0; attempt < retries; attempt++) {
    const idx = await kvSmembersSafe("orders:index");
    const orders = [];
    for (const sid of idx) {
      const o = await kvGetSafe(`order:${sid}`, null);
      if (o) orders.push(o);
    }
    lastOrders = orders;

    if (orders.length > 0 || idx.length === 0) {
      _ordersCache = orders;
      return orders;
    }

    if (attempt < retries - 1) await sleep(delayMs);
  }

  _ordersCache = lastOrders;
  return lastOrders;
}

// --- Stripe helpers: always fetch the full line item list ---
export async function fetchSessionAndItems(stripe, sid) {
  const s = await stripe.checkout.sessions.retrieve(sid, {
    expand: ["payment_intent", "customer_details"],
  });
  const liResp = await stripe.checkout.sessions.listLineItems(sid, {
    limit: 100,
    expand: ["data.price.product"],
  });
  const lineItems = liResp?.data || [];
  return { session: s, lineItems };
}


// ----- order persistence helpers -----
// NOTE: accepts optional extra object (e.g. { mode: "live" })
export async function saveOrderFromSession(sessionLike, extra = {}) {
  const requestedMode = String(extra?.mode || "").trim();
  const stripe = await getStripe(requestedMode || undefined);
  if (!stripe) throw new Error("stripe-not-configured");

  const sid = typeof sessionLike === "string" ? sessionLike : sessionLike.id;
  const { session: s, lineItems } = await fetchSessionAndItems(stripe, sid);

  if (s?.mode !== "payment" || s?.payment_status !== "paid") {
    const err = new Error("checkout-session-not-paid");
    err.code = "checkout-session-not-paid";
    throw err;
  }

  const lines = lineItems.map((li) => {
    const name = li.description || li.price?.product?.name || "Item";
    const qty = Number(li.quantity || 1);
    const unit = cents(li.price?.unit_amount || 0);
    const total = unit * qty;
    const meta = li.price?.product?.metadata || {};
    return {
      id: `${sid}:${li.id}`,
      itemName: name,
      qty,
      unitPrice: unit,
      gross: total,
      category: (meta.itemType || meta.category || "").toLowerCase() || "other",

      attendeeId: meta.attendeeId || meta.attendee_id || "",
      attendeeName: meta.attendeeName || meta.attendee_name || "",
      attendeeTitle: meta.attendeeTitle || meta.attendee_title || "",
      attendeePhone: meta.attendeePhone || meta.attendee_phone || "",
      attendeeEmail: meta.attendeeEmail || meta.attendee_email || "",
      itemId: meta.itemId || meta.item_id || "",
      meta: {
        attendeeName: meta.attendeeName || "",
        attendeeTitle: meta.attendeeTitle || "",
        attendeePhone: meta.attendeePhone || "",
        attendeeEmail: meta.attendeeEmail || "",
        attendeeCourt:
          meta.attendeeCourt ||
          meta.attendeeCourtName ||
          meta.attendee_court ||
          meta.attendee_court_name ||
          meta.court ||
          meta.courtName ||
          meta.court_name ||
          "",
        attendeeCourtNumber:
          meta.attendeeCourtNumber ||
          meta.attendeeCourtNo ||
          meta.attendeeCourtNum ||
          meta.attendee_court_number ||
          meta.attendee_court_no ||
          meta.attendee_court_num ||
          meta.courtNumber ||
          meta.court_no ||
          meta.courtNo ||
          meta.courtNum ||
          "",
        attendeeNotes: meta.attendeeNotes || "",
        dietaryNote: meta.dietaryNote || "",
        corsageChoice: meta.corsageChoice || meta.corsage_choice || meta.corsageType || meta.corsage_type || meta.choice || meta.selection || meta.style || meta.color || "",
        corsageWear: meta.corsageWear || meta.corsage_wear || meta.wear || meta.wearStyle || "",
        corsageNote: meta.corsageNote || meta.corsage_note || "",
        itemNote:
        (meta.itemNote ||
          meta.item_note ||
          meta.notes ||
          meta.note ||
          meta.message ||
          "")
        ,
        attendeeAddr1: meta.attendeeAddr1 || "",
        attendeeAddr2: meta.attendeeAddr2 || "",
        attendeeCity: meta.attendeeCity || "",
        attendeeState: meta.attendeeState || "",
        attendeePostal: meta.attendeePostal || "",
        attendeeCountry: meta.attendeeCountry || "",
        priceMode: meta.priceMode || "",
        bundleQty: meta.bundleQty || "",
        bundleTotalCents: meta.bundleTotalCents || "",
        itemType: meta.itemType || "",
        category: meta.category || "",
        passengerCount: meta.passengerCount || "",
        pickupNeeded: meta.pickupNeeded || "",
        dropoffNeeded: meta.dropoffNeeded || "",
        paymentMode: meta.paymentMode || "",
        paymentBasis: meta.paymentBasis || "",
        // Preserve the short KV reference written during checkout so the full
        // passenger and flight payload can be restored after Stripe payment.
        transportationRef: meta.transportationRef || meta.transportation_ref || "",
        transportation_ref: meta.transportation_ref || meta.transportationRef || "",
        transportJson1: meta.transportJson1 || "",
        transportJson2: meta.transportJson2 || "",
        transportJson3: meta.transportJson3 || "",
        transportJson4: meta.transportJson4 || "",
        transportJson5: meta.transportJson5 || "",
        transportJson6: meta.transportJson6 || "",
        transportJson7: meta.transportJson7 || "",
        transportJson8: meta.transportJson8 || "",
      },
      notes: "",
    };
  });

  // Restore full transportation JSON from KV when Stripe only carried a short ref.
  await hydrateTransportationLines(lines);

  // ---------------------------------------------------------------------------
  // Attendee name normalization (prevents duplicate attendee boxes on Order page)
  // ---------------------------------------------------------------------------
  try {
    const bestNameById = {};
    for (const ln of lines) {
      const aid = String(ln?.attendeeId || "").trim();
      if (!aid) continue;
      const n =
        String(ln?.attendeeName || ln?.meta?.attendeeName || "").trim() ||
        String(ln?.meta?.attendee_name || "").trim();
      if (!n) continue;
      const prev = bestNameById[aid] || "";
      if (!prev || n.length > prev.length) bestNameById[aid] = n;
    }
    for (const ln of lines) {
      const aid = String(ln?.attendeeId || "").trim();
      if (!aid) continue;
      const best = bestNameById[aid] || "";
      if (!best) continue;
      ln.attendeeName = best;
      ln.meta = ln.meta && typeof ln.meta === "object" ? ln.meta : {};
      ln.meta.attendeeName = best;
      ln.meta.attendee_name = best; // snake_case compatibility
    }
  } catch {}

  const md = s.metadata || {};
  const purchaserFromMeta = {
    name: (md.purchaser_name || "").trim(),
    email: (md.purchaser_email || "").trim(),
    phone: (md.purchaser_phone || "").trim(),
    title: (md.purchaser_title || "").trim(),
    address1: (md.purchaser_addr1 || "").trim(),
    address2: (md.purchaser_addr2 || "").trim(),
    city: (md.purchaser_city || "").trim(),
    state: (md.purchaser_state || "").trim(),
    postal: (md.purchaser_postal || "").trim(),
    country: (md.purchaser_country || "").trim(),
  };

  let order = {
    id: sid,
    created: s.created ? s.created * 1000 : Date.now(),
    payment_intent:
      typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || "",
    charge: null,
    currency: s.currency || "usd",
    amount_total: cents(s.amount_total || 0),
    customer_email: (s.customer_details?.email || purchaserFromMeta.email || "").trim(),
    purchaser: {
      name: purchaserFromMeta.name || s.customer_details?.name || "",
      email: purchaserFromMeta.email || s.customer_details?.email || "",
      phone: purchaserFromMeta.phone || s.customer_details?.phone || "",
      title: purchaserFromMeta.title || "",
      address1: purchaserFromMeta.address1 || "",
      address2: purchaserFromMeta.address2 || "",
      city: purchaserFromMeta.city || "",
      state: purchaserFromMeta.state || "",
      postal: purchaserFromMeta.postal || "",
      country: purchaserFromMeta.country || "",
    },
    lines,
    fees: { pct: 0, flat: 0 },
    refunds: [],
    refunded_cents: 0,
    status: "paid",
  };

  if (extra && typeof extra === "object") order = { ...order, ...extra };

  const piId = order.payment_intent;
  if (piId) {
    const stripe2 = await getStripe(requestedMode || undefined);
    const pi = await stripe2?.paymentIntents
      .retrieve(piId, { expand: ["charges.data"] })
      .catch(() => null);
    if (pi?.charges?.data?.length) order.charge = pi.charges.data[0].id;
  }

  // Attach immutable hash at end
  order = attachImmutableOrderHash(order);

  await kvSetSafe(`order:${order.id}`, order);
  await kvSaddSafe("orders:index", order.id);
  if (md.receipt_view_hash) {
    await kvSetSafe(`order:${order.id}:receipt_view_hash`, md.receipt_view_hash);
  }
  return order;
}

export async function applyRefundToOrder(chargeId, refund) {
  const ids = await kvSmembersSafe("orders:index");
  for (const sid of ids) {
    const key = `order:${sid}`;
    const o = await kvGetSafe(key, null);
    if (!o) continue;
    if (o.charge === chargeId || o.payment_intent === refund.payment_intent) {
      const entry = {
        id: refund.id,
        amount: cents(refund.amount || 0),
        charge: refund.charge || chargeId,
        created: refund.created ? refund.created * 1000 : Date.now(),
      };
      o.refunds = Array.isArray(o.refunds) ? o.refunds : [];
      o.refunds.push(entry);
      o.refunded_cents = (o.refunded_cents || 0) + entry.amount;
      o.status = o.refunded_cents >= o.amount_total ? "refunded" : "partial_refund";
      await kvSetSafe(key, o);
      return true;
    }
  }
  return false;
}

// --- Flatten an order into report rows (CSV-like) ---
export function flattenOrderToRows(o) {
  const rows = [];
  const mode = (o.mode || "test").toLowerCase();

  (o.lines || []).forEach((li) => {
    const net = li.gross;
    const rawId = li.itemId || "";
    const base = baseKey(rawId);
    const transport = extractTransportationFromMeta(li.meta || {});
    const isTransport = !!transport || isTransportationMeta(li.meta || {});
    const tour = extractTourFromMeta(li.meta || {});
    const isTour = !!tour || isTourLine(li);

    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: li.meta?.attendeeName || "",
      attendee_title: li.meta?.attendeeTitle || "",
      attendee_email: li.meta?.attendeeEmail || "",
      attendee_phone: isTour ? (tour?.cellPhone || li.meta?.cellPhone || li.meta?.attendeePhone || "") : (li.meta?.attendeePhone || ""),
            court: li.meta?.attendeeCourt || li.meta?.attendeeCourtName || li.meta?.attendee_court || li.meta?.attendee_court_name || li.meta?.court || li.meta?.courtName || li.meta?.court_name || li.meta?.attendeeCourtName || "",
            court_number: li.meta?.attendeeCourtNumber || li.meta?.attendeeCourtNo || li.meta?.attendeeCourtNum || li.meta?.attendee_court_number || li.meta?.attendee_court_no || li.meta?.attendee_court_num || li.meta?.courtNumber || li.meta?.court_no || li.meta?.courtNo || li.meta?.courtNum || "",
      attendee_addr1: li.meta?.attendeeAddr1 || "",
      attendee_addr2: li.meta?.attendeeAddr2 || "",
      attendee_city: li.meta?.attendeeCity || "",
      attendee_state: li.meta?.attendeeState || "",
      attendee_postal: li.meta?.attendeePostal || "",
      attendee_country: li.meta?.attendeeCountry || "",
      category: isTransport ? "transportation" : isTour ? "tour" : (li.category || "other"),
      item: li.itemName || "",
      item_id: rawId,
      corsage_wear: /(corsage|boutonniere)/.test(base) ? (li.meta?.corsageWear || li.meta?.corsage_wear || "") : "",
      qty: li.qty || 1,
      price: (li.unitPrice || 0) / 100,
      gross: (li.gross || 0) / 100,
      fees: 0,
      net: (net || 0) / 100,
      status: o.status || "paid",
      notes:
        isTransport
          ? [transportationNotes(transport), li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : isTour
          ? [tourNotes(tour), li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : li.category === "banquet"
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : [li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote]
          .filter(Boolean)
          .join("; ")
          ,
      ...transportationRowFields(transport),
      ...tourRowFields(tour, li.meta || {}),
      _itemId: rawId,
      _itemBase: base,
      _itemKey: normalizeKey(rawId),
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id,
      mode,
    });
  });

  const feeLine = (o.lines || []).find((li) => /processing fee/i.test(li.itemName || ""));
  if (feeLine) {
    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: "",
      attendee_title: "",
      attendee_email: "",
      attendee_phone: "",
      court: "",
      court_number: "",
      attendee_addr1: "",
      attendee_addr2: "",
      attendee_city: "",
      attendee_state: "",
      attendee_postal: "",
      attendee_country: "",
      category: "other",
      item: feeLine.itemName || "Processing Fee",
      item_id: "",
      qty: feeLine.qty || 1,
      price: (feeLine.unitPrice || 0) / 100,
      gross: (feeLine.gross || 0) / 100,
      net: (feeLine.gross || 0) / 100,
      fees: 0,
      status: o.status || "paid",
      notes: "",
      _itemId: "",
      _itemBase: "",
      _itemKey: "",
      _pi: o.payment_intent || "",
      _charge: o.charge || "",
      _session: o.id,
      mode,
    });
  }
  return rows;
}


// ---------------------------------------------------------------------------
// Attendee roster collector (used by reports)
// ---------------------------------------------------------------------------

export function collectAttendeesFromOrders(
  orders,
  { includeAddress = false, categories = [], startMs, endMs } = {}
) {
  const cats = (categories || []).map((c) => String(c || "").toLowerCase()).filter(Boolean);

  const allRows = [];
  for (const o of orders || []) {
    const rows = flattenOrderToRows(o);
    for (const r of rows) {
      const t = parseDateISO(r.date);
      if (startMs && !isNaN(t) && t < startMs) continue;
      if (endMs && !isNaN(t) && t >= endMs) continue;

      if (cats.length) {
        const rc = String(r.category || "").toLowerCase();
        if (!cats.includes(rc)) continue;
      }

      const base = {
        date: r.date,
        attendee: r.attendee,
        attendee_title: r.attendee_title,
        attendee_phone: r.attendee_phone,
        attendee_email: r.attendee_email,
        court: r.court,
        court_number: r.court_number,
        item: r.item,
        item_id: r.item_id,
        qty: r.qty,
        notes: r.notes,
        passenger_count: r.passenger_count || "",
        passenger_names: r.passenger_names || "",
        passenger_phones: r.passenger_phones || "",
        passenger_emails: r.passenger_emails || "",
        pickup_needed: r.pickup_needed || "",
        pickup_airport: r.pickup_airport || "",
        pickup_airline: r.pickup_airline || "",
        pickup_flight: r.pickup_flight || "",
        pickup_datetime: r.pickup_datetime || "",
        pickup_notes: r.pickup_notes || "",
        dropoff_needed: r.dropoff_needed || "",
        dropoff_airport: r.dropoff_airport || "",
        dropoff_airline: r.dropoff_airline || "",
        dropoff_flight: r.dropoff_flight || "",
        dropoff_datetime: r.dropoff_datetime || "",
        dropoff_notes: r.dropoff_notes || "",
        tour_datetime: r.tour_datetime || "",
        tour_location: r.tour_location || "",
        tour_cell_phone: r.tour_cell_phone || "",
        tour_accessibility: r.tour_accessibility || "",
        tour_notes: r.tour_notes || "",
      };

      if (includeAddress) {
        allRows.push({
          ...base,
          attendee_addr1: r.attendee_addr1,
          attendee_addr2: r.attendee_addr2,
          attendee_city: r.attendee_city,
          attendee_state: r.attendee_state,
          attendee_postal: r.attendee_postal,
          attendee_country: r.attendee_country,
        });
      } else {
        allRows.push(base);
      }
    }
  }

  return allRows;
}


