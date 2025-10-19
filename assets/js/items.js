// assets/js/items.js
window.CATALOG_ITEMS = [
  {
    id: "sunflower-pendant",
    name: "Sunflower Pendant",
    // Single-price item
    price: 25,                               // dollars
    image: "/assets/shop/sunflower-pin_thumb.jpg",// main thumb the page uses
    images: [                                // keep your gallery
      "/assets/shop/sunflower-pin_full.jpg",
      "/assets/shop/sunflower-back.jpg"
    ],
    sku: "SUN-001",
    qtyTotal: 0,   // 0 (or omit) = unlimited; set to a number to track inventory
    qtySold: 0,    // must be present; the page updates this as people buy
    active: true
  },
 
 {
    id: "amaranth-pendant",
    name: "Amaranth Pendant",
    // Single-price item
    price: 500,                               // dollars
    image: "/assets/shop/pendant_thumb.jpg",// main thumb the page uses
    images: [                                // keep your gallery
      "/assets/shop/pendant_full.jpg" ],
    sku: "AM-001",
    qtyTotal: 1,   // 0 (or omit) = unlimited; set to a number to track inventory
    qtySold: 0,    // must be present; the page updates this as people buy
    active: true
  },
 
 {
    id: "raffle-ticket",
    name: "Raffle Ticket",
    // Tiered pricing (your existing structure retained)
    tiered: true,
    pricing: [
      { qty: 1,  price: 10 },
      { qty: 3,  price: 25 },
      { qty: 10, price: 75 }
    ],
    image: "/assets/shop/Raffle-Cancun_thumb.jpg", // thumb used by the page
    images: ["/assets/shop/Raffle-Cancun_full.jpg",
	         "/assets/shop/Raffle_beaches.jpg",
	         "/assets/shop/Raffle_ruins.jpg"
	],
    sku: "RAFFLE-001",
    qtyTotal: 0,  // unlimited (raffles rarely have a cap)
    qtySold: 0,
    active: true
  },
  
  {
    id: "lottery-ticket",
    name: "Powerball Lottery Ticket",
    // Single-price item
    price: 650000000,                               // dollars
    image: "/assets/shop/Powerball_thumb.jpg",// main thumb the page uses
    images: [                                // keep your gallery
      "/assets/shop/Powerball_full.jpg" ],
    sku: "Lotto-001",
    qtyTotal: 1,   // 0 (or omit) = unlimited; set to a number to track inventory
    qtySold: 0,    // must be present; the page updates this as people buy
    active: true
  }
  
];
