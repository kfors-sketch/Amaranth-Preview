// assets/js/items.js
window.CATALOG_ITEMS = [
  {
    id: "sunflower-pendant",
    name: "Sunflower Pendant",
    // Single-price item
    price: 25, // dollars
    image: "/assets/shop/sunflower-pin_thumb.jpg",
    images: [
      "/assets/shop/sunflower-pin_full.jpg",
      "/assets/shop/sunflower-back.jpg"
    ],
    sku: "SUN-001",
    qtyTotal: 0, // 0 (or omit) = unlimited; set to a number to track inventory
    qtySold: 0,  // must be present; the page updates this as people buy
    active: true,

    // ===== reporting fields =====
    chair: { name: "Product Catalog", email: "Pa_Sessions@Yahoo.com" },
    chairEmails: ["Pa_Sessions@Yahoo.com"],
    publishStart: "", // e.g. "2026-01-01T00:00:00-05:00"
    publishEnd: ""    // treat as "ordering closes" for FINAL if used
  },

  {
    id: "amaranth-pendant",
    name: "Amaranth Pendant",
    // Single-price item
    price: 500, // dollars
    image: "/assets/shop/pendant_thumb.jpg",
    images: ["/assets/shop/pendant_full.jpg"],
    sku: "AM-001",
    qtyTotal: 1,  // set to a number to track inventory
    qtySold: 0,   // must be present; the page updates this as people buy
    active: true,

    // ===== reporting fields =====
    chair: { name: "Product Catalog", email: "Pa_Sessions@Yahoo.com" },
    chairEmails: ["Pa_Sessions@Yahoo.com"],
    publishStart: "",
    publishEnd: ""
  },

  // === Commemorative Coin (tiered). Images will 404 until you upload. ===
  {
    id: "session-coin",
    name: "Commemorative Coin",
    tiered: true,
    pricing: [
      { qty: 1, price: 10 },
      { qty: 3, price: 25 },
      { qty: 6, price: 40 }
    ],
    image: "/assets/shop/coin_thumb.jpg",   // placeholder
    images: ["/assets/shop/coin_full.jpg"], // placeholder
    sku: "COIN-001",
    qtyTotal: 0, // unlimited
    qtySold: 0,
    active: true,

    // ===== reporting fields =====
    chair: { name: "Product Catalog", email: "Pa_Sessions@Yahoo.com" },
    chairEmails: ["Pa_Sessions@Yahoo.com"],
    publishStart: "",
    publishEnd: ""
  }
];

// ===== Auto-register metadata for email reports (catalog items) =====
(function () {
  try {
    (window.CATALOG_ITEMS || []).forEach(item => {
      const payload = {
        id: item.id,
        name: item.name,
        chairEmails: Array.isArray(item.chairEmails)
          ? item.chairEmails
          : [item?.chair?.email].filter(Boolean),
        publishStart: item.publishStart || "",
        publishEnd: item.publishEnd || "" // used as "ordering closes" for FINAL report if set
      };

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