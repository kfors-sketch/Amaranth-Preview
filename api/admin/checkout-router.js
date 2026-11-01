import {
  getStripe,
  REQ_OK,
  REQ_ERR,
  cents,
  toCentsAuto,
  getEffectiveOrderChannel,
} from "./core.js";

import { storeTransportationPayload } from "./transportation.js";
import {
  calculateProcessingFeeCents,
  loadCheckoutCatalogs,
  resolveCheckoutLines,
} from "./checkout-pricing.js";

import {
  isInternationalOrder,
  computeInternationalFeeCents,
  buildInternationalFeeLineItem,
} from "./fees.js";

export async function handleCheckoutRoute(req, res, ctx = {}) {
  const { action, body = {}, requestId, errResponse } = ctx;

      if (action === "create_checkout_session") {
        try {
          const receiptViewToken = crypto.randomBytes(32).toString("base64url");
          const receiptViewHash = crypto
            .createHash("sha256")
            .update(receiptViewToken, "utf8")
            .digest("hex");
          const orderChannel = await getEffectiveOrderChannel().catch(() => "test");

          const stripe = await getStripe(orderChannel);
          if (!stripe)
            return REQ_ERR(res, 500, "stripe-not-configured", { requestId });

          const origin = req.headers.origin || `https://${req.headers.host}`;
          const success = new URL("/success.html", origin);
          success.searchParams.set("sid", "{CHECKOUT_SESSION_ID}");
          success.searchParams.set("receipt_token", receiptViewToken);
          const successUrl = success.toString().replace(
            "%7BCHECKOUT_SESSION_ID%7D",
            "{CHECKOUT_SESSION_ID}"
          );
          const cancelUrl = new URL("/order.html", origin).toString();

          if (Array.isArray(body.lines) && body.lines.length) {
            const catalogs = await loadCheckoutCatalogs();
            const lines = resolveCheckoutLines({ lines: body.lines, catalogs });
            const fees = {
              pct: Number(process.env.STRIPE_FEE_PERCENT || 2.9),
              flat: Number(process.env.STRIPE_FEE_FLAT || 0.30),
            };
            const purchaser = body.purchaser || {};

            const line_items = await Promise.all(lines.map(async (l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle =
                priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;

              const unit_amount = isBundle
                ? cents(l.bundleTotalCents)
                : toCentsAuto(l.unitPrice || 0);
              const quantity = isBundle ? 1 : Math.max(1, Number(l.qty || 1));

              // ✅ Love Gift / variable donation: include per-person amount in the item name
              // so chair/realtime emails that only show itemName still include the dollar amount.
              let displayName = String(l.itemName || "Item");
              try {
                const id = String(l.itemId || "").trim().toLowerCase();
                const t = String(l.itemType || "").trim().toLowerCase();
                const looksLikeLoveGift =
                  id === "love_gift" ||
                  id === "lovegift" ||
                  id.includes("love_gift") ||
                  id.includes("lovegift") ||
                  (t === "addon" && displayName.toLowerCase().includes("love gift")) ||
                  displayName.toLowerCase().includes("love gift");
                if (looksLikeLoveGift && Number.isFinite(unit_amount)) {
                  const amt = (Number(unit_amount) / 100).toFixed(2);
                  // Avoid double-appending if already present
                  if (!displayName.includes("$")) displayName = `${displayName} — $${amt}`;
                }
              } catch {}
              // ✅ Corsage variants: keep separate line items & show choice/note on Order page + receipts
              // We DO NOT change itemId (so chair email routing still works), but we make the Stripe product
              // name unique per variant so your UI can show "Rose Corsage" vs "Custom Corsage — note..."
              try {
                const id2 = String(l.itemId || "").trim().toLowerCase();
                const name2 = String(displayName || "").toLowerCase();
                const looksLikeCorsage =
                  id2 === "corsage" ||
                  id2 === "corsages" ||
                  id2.includes("corsage") ||
                  name2.includes("corsage");

                if (looksLikeCorsage) {
                  const choice =
                    String(
                      l?.meta?.corsageChoice ??
                        l?.meta?.corsage_choice ??
                        l?.meta?.corsageType ??
                        l?.meta?.corsage_type ??
                        l?.meta?.choice ??
                        l?.meta?.selection ??
                        l?.meta?.style ??
                        l?.meta?.color ??
                        ""
                    ).trim();

                  const wearRaw =
                    String(
                      l?.meta?.corsageWear ??
                        l?.meta?.corsage_wear ??
                        l?.meta?.wear ??
                        l?.meta?.wearStyle ??
                        l?.meta?.wear_style ??
                        l?.meta?.attachment ??
                        ""
                    ).trim();
                  const wearLower = wearRaw.toLowerCase();
                  const wearLabel =
                    wearLower === "wrist" || wearLower === "w"
                      ? "Wrist"
                      : wearLower === "pin" ||
                        wearLower === "pin-on" ||
                        wearLower === "pin on" ||
                        wearLower === "p"
                      ? "Pin-on"
                      : wearRaw;

                  const noteRaw =
                    String(
                      l?.meta?.itemNote ||
                        l?.meta?.item_note ||
                        l?.meta?.notes ||
                        l?.meta?.note ||
                        l?.meta?.message ||
                        l?.itemNote ||
                        l?.item_note ||
                        l?.notes ||
                        l?.note ||
                        l?.message ||
                        ""
                    ).trim();

                  if (choice) {
                    const lowerChoice = choice.toLowerCase();
                    // Avoid double-appending
                    if (!name2.includes(lowerChoice)) displayName = `${displayName} (${choice})`;
                  }

                  
                  if (wearLabel) {
                    const wl = String(wearLabel).toLowerCase();
                    // Avoid double-appending
                    if (!String(displayName).toLowerCase().includes(wl)) {
                      // If we already added choice as "(...)", prefer "(Choice, Wear)"
                      const m = String(displayName).match(/^(.*)\(([^)]*)\)\s*$/);
                      if (m && m[2] && !m[2].toLowerCase().includes(wl)) {
                        displayName = `${m[1]}(${m[2]}, ${wearLabel})`;
                      } else {
                        displayName = `${displayName} (${wearLabel})`;
                      }
                    }
                  }
// If it's custom, or they typed a note, include it in the displayed name (trimmed)
                  if (noteRaw) {
                    const shortNote = noteRaw.length > 90 ? noteRaw.slice(0, 87) + "…" : noteRaw;
                    if (!String(displayName).includes(shortNote)) displayName = `${displayName} — ${shortNote}`;
                  }
                }
              
                // Pre-Registration: include Voting / Non-Voting in the item name so it shows up in
                // - Stripe customer email receipts
                // - Our emailed receipt / success.html receipt
                // - Chair spreadsheets (deriveVotingStatus reads stored text)
                try {
                  const votingBool =
                    l?.meta?.isVoting ??
                    l?.meta?.votingBool ??
                    l?.meta?.voting_boolean ??
                    null;

                  const votingRaw =
                    l?.meta?.votingStatus ??
                    l?.meta?.voting_status ??
                    l?.meta?.voting ??
                    l?.meta?.votingType ??
                    l?.meta?.voting_type ??
                    l?.meta?.votingFlag ??
                    l?.meta?.voting_flag ??
                    "";

                  let votingLabel = "";
                  if (votingBool === true) votingLabel = "Voting";
                  else if (votingBool === false) votingLabel = "Non-Voting";
                  else {
                    const vr = String(votingRaw ?? "").trim().toLowerCase();
                    if (vr) {
                      if (/non\s*-?\s*voting/.test(vr) || /nonvoting/.test(vr) || vr === "nv") votingLabel = "Non-Voting";
                      else if (/\bvoting\b/.test(vr) || vr === "v") votingLabel = "Voting";
                      else if (["1", "true", "t", "yes", "y"].includes(vr)) votingLabel = "Voting";
                      else if (["0", "false", "f", "no", "n"].includes(vr)) votingLabel = "Non-Voting";
                    }
                  }

                  const isPreReg =
                    (id2.includes("pre") && (id2.includes("reg") || id2.includes("registration"))) ||
                    name2.includes("pre-registration") ||
                    name2.includes("pre registration") ||
                    name2.includes("pre reg") ||
                    name2.includes("prereg");

// Fallback: if the Order page already embedded "Voting"/"Non-Voting" in attendeeTitle/notes,
// reuse that for Stripe-visible names (Stripe does not display metadata on receipts).
if (isPreReg && !votingLabel) {
  const fromTitle = String(l?.meta?.attendeeTitle || "").toLowerCase();
  const fromNotes = String(l?.meta?.attendeeNotes || l?.meta?.attendeeNote || "").toLowerCase();
  const fromName  = String(displayName || "").toLowerCase();
  const blob = `${fromTitle} ${fromNotes} ${fromName}`.trim();
  if (blob) {
    if (blob.includes("non-voting") || blob.includes("nonvoting") || blob.includes("non voting") || /\bnv\b/.test(blob)) votingLabel = "Non-Voting";
    else if (blob.includes("voting") || /\bv\b/.test(blob)) votingLabel = "Voting";
  }
}


                  if (isPreReg && votingLabel) {
                    const dl = String(displayName || "").toLowerCase();
                    // Avoid double-appending
                    if (!dl.includes("non-voting") && !dl.includes("nonvoting") && !dl.includes("voting")) {
                      displayName = `${displayName} (${votingLabel})`;
                    }

                    // Also ensure it shows up like banquet notes in our receipt:
                    // put it into itemNote if no other notes exist.
                    try {
                      l.meta = l.meta || {};
                      const hasNotes =
                        !!(l.meta.itemNote || l.meta.item_note || l.meta.attendeeNotes || l.meta.dietaryNote);
                      if (!hasNotes) {
                        l.meta.itemNote = `Member: ${votingLabel}`;
                      }
                    } catch {}
                  }
                } catch {}
} catch {}


              const transportationMetadata = await storeTransportationPayload(
                l?.meta?.transportation || l?.transportation || null,
                { itemId: l.itemId || "", itemName: l.itemName || "", itemType: l.itemType || "" }
              );

              return {
                quantity,
                price_data: {
                  currency: "usd",
                  unit_amount,
                  product_data: {
                    name: displayName,
                    metadata: {
                      itemId: l.itemId || "",
                      itemType: l.itemType || "",
                      attendeeId: l.attendeeId || "",
                      attendeeName: l.meta?.attendeeName || "",
                      attendeeTitle: l.meta?.attendeeTitle || "",
                      attendeePhone: l.meta?.attendeePhone || "",
                      attendeeEmail: l.meta?.attendeeEmail || "",
                      attendeeNotes: l.meta?.attendeeNotes || "",
                      dietaryNote: l.meta?.dietaryNote || "",
					  attendeeCourt:
                          (l.meta?.attendeeCourt ||
                          l.meta?.attendeeCourtName ||
                          l.meta?.attendee_court ||
                          l.meta?.attendee_court_name ||
                          l.meta?.court ||
                          l.meta?.courtName ||
                          l.meta?.court_name ||
                          ""),
                      attendeeCourtNumber:
                          (l.meta?.attendeeCourtNumber ||
                          l.meta?.attendeeCourtNo ||
                          l.meta?.attendeeCourtNum ||
                          l.meta?.attendee_court_number ||
                          l.meta?.attendee_court_no ||
                          l.meta?.attendee_court_num ||
                          l.meta?.courtNumber ||
                          l.meta?.court_no ||
                          l.meta?.courtNo ||
                          l.meta?.courtNum ||
                          ""),
                      votingStatus:
                        (l.meta?.votingStatus ||
                          l.meta?.voting_status ||
                          l.meta?.voting ||
                          l.meta?.votingType ||
                          l.meta?.voting_type ||
                          ""),
                      voting_status:
                        (l.meta?.votingStatus ||
                          l.meta?.voting_status ||
                          l.meta?.voting ||
                          l.meta?.votingType ||
                          l.meta?.voting_type ||
                          ""),
                      isVoting:
                        String(
                          l.meta?.isVoting ??
                            l.meta?.votingBool ??
                            l.meta?.voting_boolean ??
                            ""
                        ),

                      itemNote:
                        (l.meta?.itemNote ||
                          l.meta?.item_note ||
                          l.meta?.notes ||
                          l.meta?.note ||
                          l.meta?.message ||
                          l.itemNote ||
                          l.item_note ||
                          l.notes ||
                          l.note ||
                          l.message ||
                          "")
                        ,
                      corsageChoice:
                        (l.meta?.corsageChoice ||
                          l.meta?.corsage_choice ||
                          l.meta?.corsageType ||
                          l.meta?.corsage_type ||
                          l.meta?.choice ||
                          l.meta?.selection ||
                          l.meta?.style ||
                          l.meta?.color ||
                          ""),
                                            corsageWear:
                        (l.meta?.corsageWear ||
                          l.meta?.corsage_wear ||
                          l.meta?.wear ||
                          l.meta?.wearStyle ||
                          l.meta?.wear_style ||
                          l.meta?.attachment ||
                          ""),
corsageNote:
                        (l.meta?.itemNote ||
                          l.meta?.item_note ||
                          l.meta?.notes ||
                          l.meta?.note ||
                          l.meta?.message ||
                          l.itemNote ||
                          l.item_note ||
                          l.notes ||
                          l.note ||
                          l.message ||
                          ""),

                      attendeeAddr1: l.meta?.attendeeAddr1 || "",
                      attendeeAddr2: l.meta?.attendeeAddr2 || "",
                      attendeeCity: l.meta?.attendeeCity || "",
                      attendeeState: l.meta?.attendeeState || "",
                      attendeePostal: l.meta?.attendeePostal || "",
                      attendeeCountry: l.meta?.attendeeCountry || "",
                      priceMode: priceMode || "",
                      bundleQty: isBundle ? String(l.bundleQty || "") : "",
                      bundleTotalCents: isBundle ? String(unit_amount) : "",
                      loveGiftAmountCents: String(unit_amount),
                      ...transportationMetadata,
                    },
                  },
                },
              };
            }));

            const pct = Number(fees.pct || 0);

            const subtotalCents = lines.reduce((s, l) => {
              const priceMode = String(l.priceMode || "").toLowerCase();
              const isBundle =
                priceMode === "bundle" && (l.bundleTotalCents ?? null) != null;
              if (isBundle) return s + cents(l.bundleTotalCents || 0);
              return s + toCentsAuto(l.unitPrice || 0) * Number(l.qty || 0);
            }, 0);

            // Compute processing fee so that, after Stripe takes (pct% + flat), you net the base subtotal.
// IMPORTANT: Stripe charges its % on the entire amount collected (including the fee line),
// so we must "gross-up" instead of base*pct + flat.
const baseCentsForFee = subtotalCents; // subtotalCents already includes bundles/qty and should match your "base"
let feeAmount = calculateProcessingFeeCents(baseCentsForFee, pct, fees.flat || 0);

if (feeAmount > 0) {
  line_items.push({
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: feeAmount,
      product_data: {
        name: "Online Processing Fee",
        metadata: { itemType: "fee", itemId: "processing-fee" },
      },
    },
  });
}

/** ✅ COUNTRY CODE FIX (only change in this block)
 * Normalizes common "United States" spellings to ISO-2 "US"
 * so you don't accidentally add the international 3% fee.
 */
function normalizeCountryCode2(raw) {
  const s = String(raw || "").trim();
  if (!s) return "US";

  const up = s.toUpperCase();

  // already ISO-2
  if (/^[A-Z]{2}$/.test(up)) return up;

  // common US variants
  if (
    up === "UNITED STATES" ||
    up === "UNITED STATES OF AMERICA" ||
    up === "U.S." ||
    up === "U.S.A." ||
    up === "USA" ||
    up === "AMERICA"
  ) {
    return "US";
  }

  // optional but safe
  if (up === "CANADA") return "CA";

  return up;
}

            const purchaserCountry = normalizeCountryCode2(
              purchaser.country || purchaser.addressCountry || "US"
            );
            const accountCountry = normalizeCountryCode2(
              process.env.STRIPE_ACCOUNT_COUNTRY || "US"
            );

            let intlFeeAmount = 0;
            if (isInternationalOrder(purchaserCountry, accountCountry)) {
              intlFeeAmount = computeInternationalFeeCents(subtotalCents, 0.03);
            }

            if (intlFeeAmount > 0) {
              const intlLine = buildInternationalFeeLineItem(intlFeeAmount, "usd");
              if (intlLine && intlLine.price_data?.product_data) {
                intlLine.price_data.product_data.name =
                  intlLine.price_data.product_data.name ||
                  "International Card Processing Fee (3%)";
                intlLine.price_data.product_data.metadata = {
                  ...(intlLine.price_data.product_data.metadata || {}),
                  itemType: "fee",
                  itemId: "intl-fee",
                };
                line_items.push(intlLine);
              } else if (intlLine) {
                line_items.push(intlLine);
              }
            }

            const session = await stripe.checkout.sessions.create({
              mode: "payment",
              line_items,
              customer_email: purchaser.email || undefined,
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: {
                order_channel: orderChannel,
                order_mode: orderChannel,
                purchaser_name: purchaser.name || "",
                purchaser_email: purchaser.email || "",
                purchaser_phone: purchaser.phone || "",
                purchaser_title: purchaser.title || "",
                purchaser_addr1: purchaser.address1 || "",
                purchaser_addr2: purchaser.address2 || "",
                purchaser_city: purchaser.city || "",
                purchaser_state: purchaser.state || "",
                purchaser_postal: purchaser.postal || "",
                // ✅ store normalized code to keep reporting consistent
                 purchaser_country: purchaserCountry || "",
                 cart_count: String(lines.length || 0),
                 receipt_view_hash: receiptViewHash,
              },
            });
            return REQ_OK(res, {
              requestId,
              url: session.url,
              id: session.id,
              mode: orderChannel,
            });
          }

          return REQ_ERR(res, 400, "server-priced-lines-required", { requestId });
        } catch (e) {
          return errResponse(res, 500, "checkout-create-failed", req, e, {
            hint:
              "If this only fails in live-test/live, it usually means STRIPE_SECRET_KEY_LIVE or webhook secret is missing/mismatched in that environment.",
          });
        }
      }


  return false;
}
import crypto from "crypto";
