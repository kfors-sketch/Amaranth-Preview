// assets/js/items.js
window.CATALOG_ITEMS = [
  {
    id: "sunflower-pendant",
    name: "Sunflower Pendant",

    // NEW: Sort Order (lower shows first)
    sortOrder: 10,

    // Single-price item
    price: 25, // dollars (item price, not shipping)

    // Per-order shipping & handling for this item (in cents).
    // Checkout logic will later charge the HIGHEST shippingCents
    // from all items in the cart, once per order.
    shippingCents: 550, // $5.50 shipping & handling

    image: "/assets/shop/sunflower-pin_thumb.jpg",
    images: ["/assets/shop/sunflower-pin_full.jpg", "/assets/shop/sunflower-back.jpg"],
    sku: "SUN-001",
    qtyTotal: 0, // 0 (or omit) = unlimited; set to a number to track inventory
    qtySold: 0,  // must be present; the page updates this as people buy
    active: true,

    // ===== reporting fields =====
    chair: { name: "Product Catalog", email: "" }, // email managed via admin
    chairEmails: [],                               // emails come from KV/admin
    publishStart: "", // e.g. "2026-01-01T00:00:00-05:00"
    publishEnd: ""    // treat as "ordering closes" for FINAL if used
  },

  {
    id: "amaranth-pendant",
    name: "Amaranth Pendant",

    // NEW: Sort Order (lower shows first)
    sortOrder: 20,

    // Single-price item
    price: 500, // dollars

    // Higher-value pendant; keep shipping safely covered.
    shippingCents: 650, // $6.50 shipping & handling

    image: "/assets/shop/pendant_thumb.jpg",
    images: ["/assets/shop/pendant_full.jpg"],
    sku: "AM-001",
    qtyTotal: 1,  // set to a number to track inventory
    qtySold: 0,   // must be present; the page updates this as people buy
    active: true,

    // ===== reporting fields =====
    chair: { name: "Product Catalog", email: "" }, // email managed via admin
    chairEmails: [],                               // emails come from KV/admin
    publishStart: "",
    publishEnd: ""
  },

  // === Commemorative Coin (tiered). Images will 404 until you upload. ===
  {
    id: "session-coin",
    name: "Commemorative Coin",

    // NEW: Sort Order (lower shows first)
    sortOrder: 30,

    tiered: true,
    pricing: [
      { qty: 1, price: 10 },
      { qty: 3, price: 25 },
      { qty: 6, price: 40 }
    ],

    // Coins are dense/heavier; give them a slightly higher shipping
    // so you never lose money, even if they push weight up a USPS tier.
    shippingCents: 750, // $7.50 shipping & handling

    image: "",   // placeholder
    images: [],  // placeholder
    sku: "COIN-001",
    qtyTotal: 0, // unlimited
    qtySold: 0,
    active: true,

    // ===== reporting fields =====
    chair: { name: "Product Catalog", email: "" }, // email managed via admin
    chairEmails: [],                               // emails come from KV/admin
    publishStart: "",
    publishEnd: ""
  }
];

// ===== Auto-register metadata for email reports (catalog items) =====
(function () {
  try {
    (window.CATALOG_ITEMS || []).forEach(item => {
      // Compute emails from item, but only send them if there are any.
      const emails = Array.isArray(item.chairEmails)
        ? item.chairEmails.filter(Boolean)
        : [item?.chair?.email].filter(Boolean);

      const payload = {
        id: item.id,
        name: item.name,

        // NEW: include sortOrder so KV copy keeps ordering
        sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : 1000,

        publishStart: item.publishStart || "",
        publishEnd: item.publishEnd || "" // used as "ordering closes" for FINAL report if set
      };

      // Only include chairEmails if we actually have some.
      if (emails.length > 0) {
        payload.chairEmails = emails;
      }

      fetch("/api/router?action=register_item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    });
  } catch (e) {
    console.warn("[catalog] auto-register failed:", e);
  }
})();
