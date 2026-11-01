const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const norm = (value) => String(value || "").trim().toLowerCase();

function isOpen(item, nowMs) {
  if (!item || item.active === false) return false;
  const start = item.publishStart ? Date.parse(item.publishStart) : NaN;
  const end = item.publishEnd ? Date.parse(item.publishEnd) : NaN;
  return (Number.isNaN(start) || nowMs >= start) && (Number.isNaN(end) || nowMs <= end);
}

function findVariant(item, line) {
  const variants = Array.isArray(item?.variants) ? item.variants : [];
  if (!variants.length) return null;
  const meta = line?.meta || {};
  const wanted = norm(
    meta.variantId || meta.variant_id || meta.variant || meta.choice ||
    line.variantId || line.bundleQty || ""
  );
  if (!wanted) return null;
  return variants.find((v) =>
    [v?.id, v?.value, v?.label, v?.name, v?.qty, v?.quantity]
      .some((candidate) => norm(candidate) === wanted)
  ) || null;
}

function configuredPrice(item, line, kind) {
  const meta = line?.meta || {};
  const priceMode = norm(item?.priceMode || item?.paymentMode || line?.priceMode || "fixed");
  const variant = findVariant(item, line);
  if (variant) return money(variant.price ?? item.price ?? 0);

  if (priceMode === "none") return 0;
  if (priceMode === "donation" || priceMode === "optionaldonation" || item?.type === "amount") {
    const entered = money(line.unitPrice);
    const minimum = money(item.minAmount ?? item.minimumAmount ?? item.minDonation ?? 0);
    if (priceMode === "donation" && entered < Math.max(minimum, 0.01)) {
      throw new Error(`amount-below-minimum:${item.id}`);
    }
    if (priceMode === "optionaldonation" && entered > 0 && entered < minimum) {
      throw new Error(`amount-below-minimum:${item.id}`);
    }
    if (entered < 0) throw new Error(`invalid-amount:${item.id}`);
    return entered;
  }

  if (line.priceMode === "bundle") {
    const bundles = Array.isArray(item?.bundles) ? item.bundles : variants;
    const wantedQty = Number(line.bundleQty || meta.bundleQty || 0);
    const bundle = bundles.find((b) => Number(b?.qty ?? b?.quantity ?? b?.id) === wantedQty);
    if (!bundle) throw new Error(`unknown-bundle:${item.id}`);
    return money(bundle.price ?? bundle.total ?? 0);
  }

  const price = money(item?.price ?? 0);
  if (price < 0 || (!price && kind !== "transportation")) throw new Error(`invalid-price:${item.id}`);
  return price;
}

function validateQuantity(item, line, kind) {
  const bundle = norm(line.priceMode) === "bundle";
  const qty = bundle ? 1 : Number(line.qty || 0);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`invalid-quantity:${item.id}`);
  const max = Number(item.maxQty || item.limitPerAttendee || item.limit || item.qtyTotal || 0);
  if (max > 0 && qty > max) throw new Error(`quantity-limit:${item.id}`);
  return qty;
}

export function calculateProcessingFeeCents(subtotalCents, pct = 2.9, flatDollars = 0.30) {
  const base = Math.max(0, Math.round(Number(subtotalCents || 0)));
  const rate = Number(pct || 0) / 100;
  const flat = Math.max(0, Math.round(Number(flatDollars || 0) * 100));
  if (!base || (rate <= 0 && flat <= 0) || rate >= 1) return 0;
  return Math.max(0, Math.ceil((base + flat) / (1 - rate)) - base);
}

export function resolveCheckoutLines({ lines, catalogs, nowMs = Date.now() }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("no-items");
  const output = [];
  let shippingCents = 0;
  const quantities = new Map();

  for (const original of lines) {
    const kindRaw = norm(original.itemType || original?.meta?.category);
    if (kindRaw === "shipping" || norm(original.itemId) === "shipping") continue;
    const kind = kindRaw === "transportation" ? "addon" : kindRaw;
    const list = catalogs[kind] || catalogs.catalog || [];
    const item = list.find((candidate) => String(candidate?.id || "") === String(original.itemId || ""));
    if (!item) throw new Error(`unknown-item:${original.itemId || ""}`);
    if (!isOpen(item, nowMs)) throw new Error(`item-unavailable:${item.id}`);

    const qty = validateQuantity(item, original, kindRaw || kind);
    const attendeeKey = String(original.attendeeId || "");
    const quantityKey = `${kind}:${item.id}:${attendeeKey}`;
    const aggregateQty = (quantities.get(quantityKey) || 0) + qty;
    const perAttendee = Number(item.limitPerAttendee || item.limit || 0);
    if (perAttendee > 0 && attendeeKey && aggregateQty > perAttendee) {
      throw new Error(`quantity-limit:${item.id}`);
    }
    quantities.set(quantityKey, aggregateQty);
    const unitPrice = configuredPrice(item, original, kindRaw || kind);
    const resolved = {
      ...original,
      itemId: item.id,
      itemType: original.itemType || item.type || item.category || kind,
      itemName: original.itemName || item.name,
      qty,
      unitPrice,
      bundleTotalCents: norm(original.priceMode) === "bundle" ? Math.round(unitPrice * 100) : original.bundleTotalCents,
      meta: { ...(original.meta || {}) },
    };
    output.push(resolved);

    if (["catalog", "supplies", "charity", "product"].includes(kindRaw)) {
      shippingCents = Math.max(shippingCents, Number(item.shippingCents || 0));
    }
  }

  if (shippingCents > 0) {
    output.push({
      id: "shipping",
      itemId: "shipping",
      itemType: "shipping",
      itemName: "Shipping & Handling",
      unitPrice: shippingCents / 100,
      qty: 1,
      attendeeId: "",
      priceMode: "flat",
      bundleQty: "",
      bundleTotalCents: "",
      meta: {},
    });
  }
  return output;
}

export async function loadCheckoutCatalogs() {
  const { kvGetSafe } = await import("./kv-utils.js");
  const [banquet, addon, tour, products, supplies, charity, categories] = await Promise.all([
    kvGetSafe("banquets", []),
    kvGetSafe("addons", []),
    kvGetSafe("tours", []),
    kvGetSafe("products", []),
    kvGetSafe("products:supplies", []),
    kvGetSafe("products:charity", []),
    kvGetSafe("catalog:categories", []),
  ]);
  const catalog = [...(products || []), ...(supplies || []), ...(charity || [])];
  for (const entry of categories || []) {
    const cat = norm(entry?.cat);
    if (cat && !["catalog", "supplies", "charity"].includes(cat)) {
      catalog.push(...((await kvGetSafe(`products:${cat}`, [])) || []));
    }
  }
  return {
    banquet: banquet || [],
    addon: addon || [],
    transportation: addon || [],
    tour: tour || [],
    catalog,
    product: catalog,
    supplies: catalog,
    charity: catalog,
  };
}
