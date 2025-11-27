// /api/admin/fees.js

/**
 * Returns true if this should be treated as an "international" order.
 *
 * @param {string} buyerCountry - e.g. "US", "CA", "PH"
 * @param {string} accountCountry - your Stripe account country, default "US"
 */
export function isInternationalOrder(buyerCountry, accountCountry = "US") {
  if (!buyerCountry) return false;
  return buyerCountry.toUpperCase() !== accountCountry.toUpperCase();
}

/**
 * Compute an international processing fee as a % of the base amount.
 *
 * @param {number} baseAmountCents - subtotal in cents
 * @param {number} rate - 0.03 = 3%
 */
export function computeInternationalFeeCents(baseAmountCents, rate = 0.03) {
  if (!baseAmountCents || baseAmountCents <= 0) return 0;
  return Math.round(baseAmountCents * rate);
}

/**
 * Build a Stripe Checkout line item for the international fee.
 *
 * @param {number} feeCents
 * @param {string} currency - "usd"
 */
export function buildInternationalFeeLineItem(feeCents, currency = "usd") {
  if (!feeCents || feeCents <= 0) return null;

  return {
    price_data: {
      currency,
      product_data: {
        name: "International card processing fee (3%)"
      },
      unit_amount: feeCents
    },
    quantity: 1
  };
}
