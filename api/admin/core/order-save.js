import { kvGetSafe, kvSaddSafe, kvSetSafe, kvSmembersSafe } from "./kv.js";
import { getStripe } from "./stripe.js";
import { attachImmutableOrderHash } from "./hashing.js";

const cents = (value) => Math.round(Number(value || 0));

// --- Stripe helpers: always fetch the full line item list ---
async function fetchSessionAndItems(stripe, sid) {
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
async function saveOrderFromSession(sessionLike, extra = {}) {
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
      category: (meta.itemType || "").toLowerCase() || "other",

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
      },
      notes: "",
    };
  });

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
    created: Date.now(),
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
    const stripe2 = await getStripe();
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

async function applyRefundToOrder(chargeId, refund) {
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


export { fetchSessionAndItems, saveOrderFromSession, applyRefundToOrder };
