
window.CATALOG_ITEMS = [
  {
    id: "sunflower-pendant",
    name: "Sunflower Pendant",
    tiered: false,
    price: 25,
    images: ["/assets/img/sunflower-front.jpg","/assets/img/sunflower-back.jpg"],
    active: true
  },
  {
    id: "raffle-ticket",
    name: "Raffle Ticket",
    tiered: true,
    pricing: [
      { qty: 1, price: 10 },
      { qty: 3, price: 25 },
      { qty: 10, price: 75 }
    ],
    images: ["/assets/img/qr-placeholder.svg"],
    active: true
  }
];
