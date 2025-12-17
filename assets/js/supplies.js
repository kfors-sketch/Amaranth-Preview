// /assets/js/supplies.js
// Supreme Council Order of the Amaranth — Price List 2026
// Source: "Supreme Price List 2026" PDF.
//
// Notes:
// - Items with a numeric price are purchasable (active: true) WHEN master publish is enabled.
// - Items marked N/A or "Available/Upon/Request/Prices" are included for completeness (active: false).
// - When ordering SEALS, collect: Court Name, Court Number, Date Organized, Location.
// - Packaging: minimum $2.00 packaging charge (see PDF note). Your checkout logic can apply this
//   once per supplies order if desired.

(function () {
  const CHAIR_NAME = "HL Patti Baker";
  const CHAIR_EMAIL = "kfors@verizon.net";

  const chair = { name: CHAIR_NAME, email: CHAIR_EMAIL };
  const chairEmails = [CHAIR_EMAIL];

  // Optional: make the packaging fee available to other scripts
  window.SUPPLIES_PACKAGING_FEE_CENTS = 200;

  // =========================================================
  // ✅ PAGE VISIBILITY SWITCH (controls whether supplies.html should be reachable)
  // Set TRUE later when you want Supplies visible again.
  // =========================================================
  window.SUPPLIES_ACTIVE = false;

  // Optional future-proofing: publish window fields (leave blank for now)
  window.SUPPLIES_PUBLISH_START = ""; // "2026-01-01"
  window.SUPPLIES_PUBLISH_END = "";   // "2026-12-31"

  // =========================================================
  // ✅ MASTER SWITCH FOR PRICED ITEMS (controls purchasability)
  // If page is active but you still want everything "view only", keep this FALSE.
  // =========================================================
  const SUPPLIES_PUBLISHED = false;

  const mkId = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

  const base = (category, name) => ({
    id: `sup-${mkId(category)}-${mkId(name)}`,
    name,
    category,
    image: "",
    images: [],
    qtyTotal: 0,
    qtySold: 0,

    // Master publish controls availability for ALL priced items.
    // Request-only items are always inactive regardless.
    active: SUPPLIES_PUBLISHED,

    chair,
    chairEmails,
    publishStart: "",
    publishEnd: "",
    reportFrequency: "monthly",
    shippingCents: 0,
  });

  const priced = (category, name, priceDollars, extra = {}) => ({
    ...base(category, name),
    price: Number(priceDollars),
    ...extra,
  });

  const requestOnly = (category, name, note, extra = {}) => ({
    ...base(category, name),
    // Always inactive — these are "upon request / N/A"
    active: false,
    price: 0,
    priceText: String(note || "Available upon request"),
    description: String(note || "Available upon request"),
    ...extra,
  });

  // Helper: these items require Court info fields (per PDF notes).
  const courtInfo = { requiresCourtInfo: true };

  window.SUPPLIES_ITEMS = [
    // =========================
    // BOOKS
    // =========================
    priced("BOOKS", "Ante Room Register - Spiral Bound", 10.0),
    priced("BOOKS", "Secretary's Cash Book - Spiral Bound", 10.0),
    priced("BOOKS", "Treasurer's Account Book - Spiral Bound", 10.0),
    priced("BOOKS", "Minute Book - Spiral Bound", 17.0),
    priced("BOOKS", "Ledger - Spiral Bound", 23.0),
    priced("BOOKS", "Treasurer's Receipt Book #120", 5.0),
    priced("BOOKS", "Warrant Book #122", 5.0),
    priced("BOOKS", "Property Receipt Book #209", 1.4),
    priced("BOOKS", "Roll Call Book", 2.5),
    priced("BOOKS", "Manual of Procedures - Filler Only", 8.0),
    priced("BOOKS", "Constitution, (Enlarged)", 7.5),
    priced("BOOKS", "Penal Code (enlarged)", 5.5),

    priced("BOOKS", "Small Ritual- Filler", 8.5),
    priced("BOOKS", "Small Ritual - Cover", 6.5),
    priced("BOOKS", "Small Ritual - Individual", 8.5),

    priced("BOOKS", "Large Large Ritual- Filler", 14.5),
    priced("BOOKS", "Large Ritual - Cover", 8.0),
    priced("BOOKS", "Large Ritual - Pair (2)", 30.0),

    priced("BOOKS", "2024 Small Rtual updates Individual", 15.0),
    requestOnly("BOOKS", "2024 Large Ritual updates", "Listed (price not shown on this sheet)"),

    priced("BOOKS", "Secretary's Hand Book", 27.0),
    priced("BOOKS", "Court Book, Rules & Regulations", 6.0),
    priced("BOOKS", "Funeral Service Booklet", 4.0),

    // =========================
    // CARDS
    // =========================
    priced("CARDS", "Code Cards", 0.25),
    priced("CARDS", "Dues Cards #124 (per sheet of 5) sub to change", 0.43),
    priced("CARDS", "Dues Cards #124A (per sheet of 5) sub to change", 0.45),
    priced("CARDS", "Honorary Membership Cards, Sub. Ct.", 0.1),
    priced("CARDS", "Honorary Member Cards, Gr. Ct.", 0.2),
    requestOnly("CARDS", "Escort Cards form for printing availavle", "Available (form for printing)"),
    priced("CARDS", "Life Member Card #200", 0.25),

    // =========================
    // CERTIFICATES
    // =========================
    priced("CERTIFICATES", "25 Year Certificate", 1.0),
    priced("CERTIFICATES", "50 Year Certificate", 1.0),
    priced("CERTIFICATES", "Honorary Membership #404 Sub Ct", 0.6),
    priced("CERTIFICATES", "Honorary Membership #127 Gr Ct", 0.6),
    priced("CERTIFICATES", "Life Member #202 (each)", 0.6),
    requestOnly("CERTIFICATES", "Gold Seals (each)", "N/A"),

    // =========================
    // CHARTERS
    // =========================
    priced("CHARTERS", "Charter, Sub. Ct.", 1.5),

    // =========================
    // COMPUTER DISCS
    // =========================
    priced("COMPUTER DISCS", "Form Flash Drive", 10.0),

    // =========================
    // DISPENSATIONS
    // =========================
    priced("DISPENSATIONS", "GRM's #302 (per pad)", 4.2),
    priced("DISPENSATIONS", "To Organize a Court, (each)", 0.75, courtInfo),
    priced("DISPENSATIONS", "Petition to Organize a Court (each)", 1.1, courtInfo),
    priced("DISPENSATIONS", "Procedure to Organize a Court (each)", 0.75, courtInfo),

    // =========================
    // FLAGS
    // =========================
    priced("FLAGS", "Amaranth subject to change-New", 450.0),

    // =========================
    // SEALS
    // =========================
    priced("SEALS", "Hand (Model 1280) - includes postage", 130.0, courtInfo),
    priced("SEALS", "Desk (Model 1218) - Recommended - includes postage", 130.0, courtInfo),
    priced("SEALS", "Self-inking stamp - includes postage", 75.0, courtInfo),

    // =========================
    // STANDARDS & BANNERS
    // =========================
    requestOnly("STANDARDS & BANNERS", "Standard, White Satin", "Prices"),
    requestOnly("STANDARDS & BANNERS", "Banners, 4 Red Satin", "Available"),
    requestOnly("STANDARDS & BANNERS", "Banners, Red Satin, (each)", "Upon Request"),
    requestOnly("STANDARDS & BANNERS", 'Knobs, Stan. & Banner Set 1" & 3/4"', "Request"),
    requestOnly("STANDARDS & BANNERS", "Tassels & Cords, Standard (each)", "Prices"),
    requestOnly("STANDARDS & BANNERS", "Tassels & Cords, Banners (each)", "Available"),
    requestOnly("STANDARDS & BANNERS", "Rods & Ends for Standards", "Upon Request"),
    requestOnly("STANDARDS & BANNERS", "Rods & Ends for Banners", "Request"),

    // =========================
    // STAFF TOPS
    // =========================
    priced("STAFF TOPS", "Set of 7 if available", 55.0),
    priced("STAFF TOPS", "Individual", 8.5),

    // =========================
    // WREATHS
    // =========================
    priced("WREATHS", "Pair (2)", 30.0),
    priced("WREATHS", "Individual", 15.0),
    priced("WREATHS", 'Casket, 6" (1)', 7.25),

    // =========================
    // HISTORIES
    // =========================
    requestOnly("HISTORIES", "Membership Promotion/History Brouchure", "N/A"),

    // =========================
    // LETTERS
    // =========================
    priced("LETTERS", "SRM Official Letter (per page) emailed", 0.25),
    priced("LETTERS", "Supreme Lecturer (per page) Emailed", 0.2),

    // =========================
    // PETITION - BLANKS - NOTICES
    // =========================
    priced("PETITION - BLANKS - NOTICES", "Annual Return, Sub. Ct. to Gr. Ct. #115 (each)", 0.15),
    priced("PETITION - BLANKS - NOTICES", "Official Ballots, GR. Ct. #128 (per 100)", 1.25),
    priced("PETITION - BLANKS - NOTICES", "Syllabus (each)", 1.0),
    priced("PETITION - BLANKS - NOTICES", "Amaranth Stationery 5-1/ 2 x 8-1/2 (pad)", 1.5),

    // =========================
    // PARAPHERNALIA
    // =========================
    priced("PARAPHERNALIA", "Ballot Balls, white (per 100)", 5.7),
    priced("PARAPHERNALIA", "Black Cubes (each)", 0.25),

    // =========================
    // BIBLES
    // =========================
    requestOnly("BIBLES", "White, Altar Not stocked", "N/A"),
    priced("BIBLES", "Black Cubes (each)", 0.25),

    // =========================
    // FLAG & TOPS
    // =========================
    priced('FLAG & TOPS', 'Eagle, 7" spread (each)', 38.0),
    priced('FLAG & TOPS', 'Eagle, 6" spread (each)', 20.0),
    priced('FLAG & TOPS', 'Eagle, 5" spread (each)', 23.0),

    // =========================
    // JEWELS
    // =========================
    priced("JEWELS", "Subordinate Court (set of 21)", 490.0),
    priced("JEWELS", "Subordinate Court (individual)", 25.0),
    priced("JEWELS", "Grand Court (set of 32)", 825.0),
    priced("JEWELS", "Grand Court (individual)", 31.25),
    priced("JEWELS", "25 Year Pins (each)", 5.0),
    priced("JEWELS", "50 Year Pins (each)", 5.0),
  ];
})();
