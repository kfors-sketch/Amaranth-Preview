import { dollarsToCents } from "./env.js";

// --- Flatten an order into report rows (CSV-like) ---
function flattenOrderToRows(o) {
  const rows = [];
  const mode = (o.mode || "test").toLowerCase();

  (o.lines || []).forEach((li) => {
    const net = li.gross;
    const rawId = li.itemId || "";
    const base = baseKey(rawId);

    rows.push({
      id: o.id,
      date: new Date(o.created || Date.now()).toISOString(),
      purchaser: o.purchaser?.name || o.customer_email || "",
      attendee: li.meta?.attendeeName || "",
      attendee_title: li.meta?.attendeeTitle || "",
      attendee_email: li.meta?.attendeeEmail || "",
      attendee_phone: li.meta?.attendeePhone || "",
            court: li.meta?.attendeeCourt || li.meta?.attendeeCourtName || li.meta?.attendee_court || li.meta?.attendee_court_name || li.meta?.court || li.meta?.courtName || li.meta?.court_name || li.meta?.attendeeCourtName || "",
            court_number: li.meta?.attendeeCourtNumber || li.meta?.attendeeCourtNo || li.meta?.attendeeCourtNum || li.meta?.attendee_court_number || li.meta?.attendee_court_no || li.meta?.attendee_court_num || li.meta?.courtNumber || li.meta?.court_no || li.meta?.courtNo || li.meta?.courtNum || "",
      attendee_addr1: li.meta?.attendeeAddr1 || "",
      attendee_addr2: li.meta?.attendeeAddr2 || "",
      attendee_city: li.meta?.attendeeCity || "",
      attendee_state: li.meta?.attendeeState || "",
      attendee_postal: li.meta?.attendeePostal || "",
      attendee_country: li.meta?.attendeeCountry || "",
      category: li.category || "other",
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
        li.category === "banquet"
          ? [li.meta?.attendeeNotes, li.meta?.dietaryNote].filter(Boolean).join("; ")
          : [li.meta?.itemNote, li.meta?.attendeeNotes, li.meta?.dietaryNote]
          .filter(Boolean)
          .join("; ")
          ,
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

// --- Helper to estimate Stripe fee from items + shipping ---
function computeStripeProcessingFeeFromLines(
  lines,
  { stripePct = 0.029, stripeFlatCents = 30 } = {}
) {
  if (!Array.isArray(lines) || !lines.length) return 0;

  let itemsSubtotal = 0;
  let shipping = 0;

  for (const li of lines) {
    const name = li.itemName || "";
    const qty = Number(li.qty || 1);
    const lineCents = Number(li.unitPrice || 0) * qty;
    const cat = String(li.category || "").toLowerCase();
    const itemId = String(li.itemId || "").toLowerCase();
    const metaType = String(li.meta?.itemType || "").toLowerCase();

    const isProcessingFee =
      itemId === "processing-fee" ||
      ((cat === "fee" || metaType === "fee" || metaType === "other") &&
        /processing\s*fee/i.test(name));
    const isIntlFee = itemId === "intl-fee" || /international card processing fee/i.test(name);
    const isShipping = cat === "shipping" || metaType === "shipping" || itemId === "shipping";

    if (isProcessingFee || isIntlFee) continue;
    if (isShipping) {
      shipping += lineCents;
      continue;
    }
    itemsSubtotal += lineCents;
  }

  const base = itemsSubtotal + shipping;
  if (base <= 0) return 0;
  return Math.round(base * stripePct + stripeFlatCents);
}


export { flattenOrderToRows, computeStripeProcessingFeeFromLines };
