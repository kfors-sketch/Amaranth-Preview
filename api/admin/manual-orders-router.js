// /api/admin/manual-orders-router.js
// Admin-only manual/mail-in and group meal order entry.
// Stores orders using the same order:* style used elsewhere, with generous
// aliases so existing reporting/export code can flatten the rows.
import {
  REQ_OK,
  REQ_ERR,
  kv,
  kvSaddSafe,
  kvSetSafe,
} from "./core.js";
import {
  createManualOrderOnly,
  authorizeManualMutation,
  findForbiddenStripeField,
  generateManualOrderId,
  normalizeManualPaymentMethod,
  recordManualOrderAudit,
} from "./manual-order-security.js";

const VALID_ACTIONS = new Set(["create_manual_order", "create_group_meal_order"]);
const VALID_MODES = new Set(["test", "live_test", "live"]);

function safeStr(v) {
  return String(v ?? "").trim();
}

function slug(v) {
  return safeStr(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function centsFromDollars(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function dollars(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function normalizeSource(v, fallback = "mail_in") {
  const s = safeStr(v).toLowerCase().replace(/[\s-]+/g, "_");
  const allowed = new Set([
    "online",
    "mail_in",
    "phone",
    "walk_in",
    "jurisdiction_group",
    "club_board_group",
    "complimentary",
    "admin_adjustment",
  ]);
  return allowed.has(s) ? s : fallback;
}

function normalizePaymentMethod(v) {
  return normalizeManualPaymentMethod(v);
}

function normalizeStatus(v, amountPaid, total) {
  const s = safeStr(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (["paid", "pending", "partial_payment", "complimentary", "cancelled", "refunded", "deposit_pending"].includes(s)) {
    return s === "partial_payment" ? "pending" : s;
  }
  if (total <= 0) return "complimentary";
  if (amountPaid >= total) return "paid";
  if (amountPaid > 0) return "pending";
  return "pending";
}

function buildLine(raw, idx, purchaser, orderMeta = {}) {
  const qty = Math.max(1, Number(raw?.qty || raw?.quantity || 1) || 1);
  const unitPrice = dollars(raw?.unitPrice ?? raw?.price ?? 0);
  const lineTotal = dollars(raw?.lineTotal ?? raw?.total ?? unitPrice * qty);
  const decorationFeeEach = dollars(raw?.decorationFee ?? raw?.decorationFeeEach ?? 0);
  const decorationFeeTotal = dollars(decorationFeeEach * qty);
  const itemId = safeStr(raw?.itemId || raw?.id || raw?.sku || `manual-item-${idx + 1}`);
  const itemName = safeStr(raw?.itemName || raw?.name || raw?.item || "Manual meal item");
  const category = safeStr(raw?.category || "banquet").toLowerCase() || "banquet";
  const attendeeName = safeStr(raw?.attendeeName || raw?.attendee || purchaser.name || "");
  const mealChoice = safeStr(raw?.mealChoice || raw?.choice || "");
  const dietaryNotes = safeStr(raw?.dietaryNotes || raw?.dietary || "");
  const notes = safeStr(raw?.notes || "");

  const meta = {
    ...(raw?.meta && typeof raw.meta === "object" ? raw.meta : {}),
    category,
    source: orderMeta.orderSource,
    orderSource: orderMeta.orderSource,
    paymentMethod: orderMeta.paymentMethod,
    attendeeName,
    mealChoice,
    dietaryNotes,
    decorationFeeEach,
    decorationFeeTotal,
    groupType: orderMeta.groupType || "",
    groupName: orderMeta.groupName || "",
    isAddOn: !!orderMeta.isAddOn,
    parentOrderId: orderMeta.parentOrderId || "",
    addOnNote: orderMeta.addOnNote || "",
    groupAggregationKey: orderMeta.groupAggregationKey || "",
    buffet: !!raw?.buffet,
    groupOnly: !!raw?.groupOnly,
  };

  return {
    id: itemId,
    item_id: itemId,
    itemId,
    sku: itemId,
    name: itemName,
    item: itemName,
    item_name: itemName,
    description: itemName,
    category,
    type: category,
    qty,
    quantity: qty,
    unit_price: unitPrice,
    unitPrice,
    price: unitPrice,
    amount: lineTotal,
    total: lineTotal,
    line_total: lineTotal,
    lineTotal,
    amount_cents: centsFromDollars(lineTotal),
    total_cents: centsFromDollars(lineTotal),
    unit_price_cents: centsFromDollars(unitPrice),
    attendee: attendeeName,
    attendee_name: attendeeName,
    attendeeName,
    mealChoice,
    dietaryNotes,
    notes: [mealChoice ? `Choice: ${mealChoice}` : "", dietaryNotes ? `Dietary: ${dietaryNotes}` : "", notes]
      .filter(Boolean)
      .join(" • "),
    decorationFee: decorationFeeEach,
    decorationFeeEach,
    decorationFeeTotal,
    hotelAmount: dollars(lineTotal - decorationFeeTotal),
    meta,
    metadata: meta,
  };
}

async function saveManualOrder(order) {
  const saved = await createManualOrderOnly({ kv, order });
  const key = `order:${saved.id}`;
  await kvSetSafe(`${key}:json`, order);
  await kvSaddSafe("order:index", saved.id);
  await kvSaddSafe("orders:index", saved.id);
  await kvSaddSafe(`orders:${saved.mode}`, saved.id);
  await kvSaddSafe(`manual_orders:index`, saved.id);
  return { key, order: saved };
}

function buildOrder(body, kind) {
  const now = new Date().toISOString();
  const purchaser = body?.purchaser && typeof body.purchaser === "object" ? body.purchaser : {};
  const payment = body?.payment && typeof body.payment === "object" ? body.payment : {};
  const group = body?.group && typeof body.group === "object" ? body.group : {};

  const groupTypeRaw = safeStr(group.groupType || body?.groupType || "").toLowerCase().replace(/[\s-]+/g, "_");
  const groupType = groupTypeRaw === "club" ? "club_board" : groupTypeRaw;
  const groupName = safeStr(group.groupName || body?.groupName || "");
  const prefix = kind === "group" ? "grp" : "manual";

  const orderSource = kind === "group"
    ? (groupType === "club_board" ? "club_board_group" : "jurisdiction_group")
    : normalizeSource(body?.orderSource || body?.source, "mail_in");

  if (safeStr(body?.id || body?.orderId || body?.order_id)) throw new Error("caller-order-id-not-allowed");
  const forbidden = findForbiddenStripeField(body);
  if (forbidden) throw new Error(`manual-stripe-field-not-allowed:${forbidden}`);
  const paymentMethod = normalizePaymentMethod(payment.paymentMethod || body?.paymentMethod || "check");
  const mode = VALID_MODES.has(safeStr(body?.mode).toLowerCase()) ? safeStr(body.mode).toLowerCase() : "live";
  const enteredBy = safeStr(body?.enteredBy || payment.enteredBy || "Admin");
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  if (!rawLines.length) throw new Error("At least one meal/item line is required.");

  const buyer = {
    name: safeStr(purchaser.name || body?.buyerName || groupName || "Manual purchaser"),
    email: safeStr(purchaser.email || body?.email || ""),
    phone: safeStr(purchaser.phone || body?.phone || ""),
    jurisdiction: safeStr(purchaser.jurisdiction || body?.jurisdiction || groupName || ""),
    court: safeStr(purchaser.court || body?.court || ""),
    address1: safeStr(purchaser.address1 || body?.address1 || ""),
    address2: safeStr(purchaser.address2 || body?.address2 || ""),
    city: safeStr(purchaser.city || body?.city || ""),
    state: safeStr(purchaser.state || body?.state || ""),
    postal: safeStr(purchaser.postal || purchaser.zip || body?.postal || body?.zip || ""),
    country: safeStr(purchaser.country || body?.country || "US") || "US",
  };

  const isAddOn = !!(body?.isAddOn || body?.entryType === "add_on" || group.isAddOn);
  const parentOrderId = safeStr(body?.parentOrderId || group.parentOrderId || "");
  const addOnNote = safeStr(body?.addOnNote || group.addOnNote || "");
  const groupAggregationKey = safeStr(
    body?.groupAggregationKey ||
    group.groupAggregationKey ||
    [slug(groupType || "group"), slug(groupName || "group")].filter(Boolean).join("__")
  );

  const orderMeta = { orderSource, paymentMethod, groupType, groupName, isAddOn, parentOrderId, addOnNote, groupAggregationKey };
  const lines = rawLines.map((line, idx) => buildLine(line, idx, buyer, orderMeta));
  const subtotal = dollars(lines.reduce((sum, l) => sum + dollars(l.lineTotal ?? l.total ?? l.amount), 0));
  const decorationFeeTotal = dollars(lines.reduce((sum, l) => sum + dollars(l.decorationFeeTotal), 0));
  const hotelAmount = dollars(subtotal - decorationFeeTotal);
  const processingFee = 0;
  const amountPaid = dollars(payment.amountPaid ?? body?.amountPaid ?? subtotal);
  const balanceDue = dollars(Math.max(0, subtotal - amountPaid));
  const status = normalizeStatus(payment.status || body?.status, amountPaid, subtotal);

  const idBase = kind === "group" ? `${slug(groupType || "group")}-${slug(groupName || "group")}` : slug(buyer.name || "manual");
  const id = generateManualOrderId(`${prefix}_${idBase || "order"}`);

  return {
    id,
    order_id: id,
    session_id: id,
    sessionId: id,
    payment_intent: "",
    charge: "",
    mode,
    source: "admin-manual",
    orderSource: "admin-manual",
    order_source: "admin-manual",
    manualSource: orderSource,
    manual_source: orderSource,
    stripeVerified: false,
    stripe_verified: false,
    kind: kind === "group" ? "group_meal_order" : "manual_order",
    status,
    paymentStatus: status,
    payment_status: status,
    paymentMethod,
    payment_method: paymentMethod,
    checkNumber: safeStr(payment.checkNumber || body?.checkNumber || ""),
    check_number: safeStr(payment.checkNumber || body?.checkNumber || ""),
    dateReceived: safeStr(payment.dateReceived || body?.dateReceived || now.slice(0, 10)),
    date_received: safeStr(payment.dateReceived || body?.dateReceived || now.slice(0, 10)),
    deposited: !!payment.deposited,
    depositedAt: safeStr(payment.depositedAt || ""),
    enteredBy,
    entered_by: enteredBy,
    enteredAt: now,
    entered_at: now,
    created: now,
    createdAt: now,
    created_at: now,
    date: now,
    buyer: buyer.name,
    buyer_name: buyer.name,
    purchaser: buyer.name,
    purchaser_name: buyer.name,
    customer_name: buyer.name,
    email: buyer.email,
    phone: buyer.phone,
    address1: buyer.address1,
    address2: buyer.address2,
    city: buyer.city,
    state: buyer.state,
    postal: buyer.postal,
    zip: buyer.postal,
    country: buyer.country,
    jurisdiction: buyer.jurisdiction,
    court: buyer.court,
    groupType,
    group_type: groupType,
    groupName,
    group_name: groupName,
    groupContact: safeStr(group.contactName || ""),
    group_contact: safeStr(group.contactName || ""),
    groupEmail: safeStr(group.contactEmail || ""),
    groupPhone: safeStr(group.contactPhone || ""),
    subtotal,
    total: subtotal,
    amount: subtotal,
    amount_total: centsFromDollars(subtotal),
    subtotal_cents: centsFromDollars(subtotal),
    total_cents: centsFromDollars(subtotal),
    amount_paid: amountPaid,
    amountPaid,
    amount_paid_cents: centsFromDollars(amountPaid),
    balanceDue,
    balance_due: balanceDue,
    balance_due_cents: centsFromDollars(balanceDue),
    processingFee,
    processing_fee: processingFee,
    processing_fee_cents: 0,
    feeMode: "none",
    fee_mode: "none",
    decorationFeeTotal,
    decoration_fee_total: decorationFeeTotal,
    decoration_fee_total_cents: centsFromDollars(decorationFeeTotal),
    hotelAmount,
    hotel_amount: hotelAmount,
    hotel_amount_cents: centsFromDollars(hotelAmount),
    notes: safeStr(body?.notes || payment.notes || ""),
    adminNotes: safeStr(body?.adminNotes || ""),
    lines,
    items: lines,
    line_items: lines,
    metadata: {
      source: orderSource,
      orderSource,
      paymentMethod,
      noProcessingFee: true,
      groupType,
      groupName,
      decorationFeeTotal,
      hotelAmount,
    },
  };
}

export async function handleManualOrdersRoute(req, res, ctx = {}) {
  const { action, body = {}, requestId, errResponse, requireAdminAuth } = ctx;
  if (req.method !== "POST" || !VALID_ACTIONS.has(action)) return false;

  try {
    if (!(await authorizeManualMutation({ req, res, requireAdminAuth }))) return true;
    const kind = action === "create_group_meal_order" ? "group" : "manual";
    const order = buildOrder(body, kind);
    const saved = await saveManualOrder(order);
    await recordManualOrderAudit({ kv, action: "create", order: saved.order, administrator: saved.order.enteredBy });
    return REQ_OK(res, {
      requestId,
      ok: true,
      action,
      id: saved.order.id,
      key: saved.key,
      mode: saved.order.mode,
      total: saved.order.total,
      amountPaid: saved.order.amountPaid,
      balanceDue: saved.order.balanceDue,
      decorationFeeTotal: saved.order.decorationFeeTotal,
      hotelAmount: saved.order.hotelAmount,
      lineCount: saved.order.lines.length,
    });
  } catch (e) {
    return errResponse
      ? errResponse(res, 500, `${action}-failed`, req, e)
      : REQ_ERR(res, 500, `${action}-failed`, { requestId, message: e?.message || String(e) });
  }
}
