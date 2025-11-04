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

    // ===== reporting fields (new) =====
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
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
    qtyTotal: 1, // 0 (or omit) = unlimited; set to a number to track inventory
    qtySold: 0,  // must be present; the page updates this as people buy
    active: true,

    // ===== reporting fields (new) =====
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"],
    publishStart: "",
    publishEnd: ""
  },

  {
    id: "raffle-ticket",
    name: "Raffle Ticket",
    // Tiered pricing
    tiered: true,
    pricing: [
      { qty: 1, price: 10 },
      { qty: 3, price: 25 },
      { qty: 6, price: 40 }
    ],
    image: "/assets/shop/Raffle-Cancun_thumb.jpg",
    images: [
      "/assets/shop/Raffle-Cancun_full.jpg",
      "/assets/shop/Raffle_beaches.jpg",
      "/assets/shop/Raffle_ruins.jpg"
    ],
    sku: "RAFFLE-001",
    qtyTotal: 0, // unlimited (raffles rarely have a cap)
    qtySold: 0,
    active: true,

    // ===== reporting fields (new) =====
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"],
    publishStart: "",
    publishEnd: ""
  },

  {
    id: "lottery-ticket",
    name: "ball",
    // Single-price item
    price: 1, // dollars
    image: "/assets/shop/Powerball_thumb.jpg",
    images: ["/assets/shop/Powerball_full.jpg"],
    sku: "Lotto-001",
    qtyTotal: 1,
    qtySold: 0,
    active: false,

    // ===== reporting fields (new) =====
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
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