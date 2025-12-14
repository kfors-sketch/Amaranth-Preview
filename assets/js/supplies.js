// /assets/js/supplies.js
// Supreme Council Order of the Amaranth — Price List 2026
// Source: "Supreme Price List 2026" PDF.
//
// Notes:
// - Items with a numeric price are purchasable (active: true).
// - Items marked N/A or "upon request" are included for completeness (active: false).
// - When ordering Court seals / organizing a court, collect:
//     Court Name, Court Number, Date Organized, Location.

(function () {
  const CHAIR_NAME = "HL Patti Baker";
  const CHAIR_EMAIL = "Supremesecretary@amaranth.org";

  const chair = { name: CHAIR_NAME, email: CHAIR_EMAIL };
  const chairEmails = [CHAIR_EMAIL];

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
    active: true,
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
    active: false,
    price: 0,
    priceText: String(note || "Available upon request"),
    description: String(note || "Available upon request"),
    ...extra,
  });

  window.SUPPLIES_ITEMS = [
    // ===== SEALS / EQUIPMENT (priced on the sheet) =====
    priced("Seals", "Hand (Model 1280) - includes postage", 130.0),
    priced("Seals", "Desk (Model 1218) - recommended - includes postage", 130.0),
    priced("Seals", "Self-inking stamp - includes postage", 75.0),

    // ===== BOOKS =====
    priced("Books", "Ante Room Register - Spiral Bound", 10.0),
    priced("Books", "Secretary's Cash Book - Spiral Bound", 10.0),
    priced("Books", "Treasurer's Account Book - Spiral Bound", 10.0),
    priced("Books", "Minute Book - Spiral Bound", 17.0),
    priced("Books", "Ledger - Spiral Bound", 23.0),
    priced("Books", "Treasurer's Receipt Book #120", 5.0),
    priced("Books", "Warrant Book #122", 5.0),
    priced("Books", "Property Receipt Book #209", 1.4),
    priced("Books", "Roll Call Book", 2.5),
    priced("Books", "Manual of Procedures - Filler Only", 8.0),
    priced("Books", "Constitution (Enlarged)", 7.5),
    priced("Books", "Penal Code (Enlarged)", 5.5),
    priced("Books", "Small Ritual - Filler", 8.5),
    priced("Books", "Small Ritual - Cover", 6.5),
    priced("Books", "Large Ritual - Filler", 14.5),
    priced("Books", "Large Ritual - Cover", 8.0),
    priced("Books", "2024 Small Ritual updates (Individual)", 15.0),
    priced("Books", '2024 Large Ritual updates (Casket, 6")', 7.25),
    priced("Books", "Secretary's Hand Book", 27.0),
    priced("Books", "Court Book, Rules & Regulations", 6.0),
    priced("Books", "Funeral Service Booklet", 4.0),

    // ===== STAFF TOPS (priced on the sheet) =====
    priced("Staff Tops", "Set of 7 (if available)", 55.0),
    priced("Staff Tops", "Individual", 8.5),

    // ===== WREATHS (priced on the sheet) =====
    priced("Wreaths", "Pair (2)", 30.0),

    // ===== HISTORIES / OTHER =====
    requestOnly("Histories", "Membership Promotion/History Brochure", "N/A (not stocked)"),

    // ===== LETTERS =====
    priced("Letters", "SRM Official Letter (per page) emailed", 0.25),
    priced("Letters", "Supreme Lecturer (per page) emailed", 0.2),

    // ===== CARDS =====
    priced("Cards", "Code Cards", 0.25),
    priced("Cards", "Dues Cards #124 (per sheet of 5)", 0.43, { description: "subject to change" }),
    priced("Cards", "Dues Cards #124A (per sheet of 5)", 0.45, { description: "subject to change" }),
    priced("Cards", "Honorary Membership Cards, Sub. Ct. (each)", 0.1),
    priced("Cards", "Honorary Member Cards, Gr. Ct. (each)", 0.2),
    requestOnly("Cards", "Escort Cards form for printing", "Available (form for printing)"),
    priced("Cards", "Life Member Card #200 (each)", 0.25),

    // ===== PETITION - BLANKS - NOTICES =====
    priced("Petitions/Notices", "Annual Return, Sub. Ct. to Gr. Ct. #115 (each)", 0.15),
    priced("Petitions/Notices", "Official Ballots, Gr. Ct. #128 (per 100)", 1.25),
    priced("Petitions/Notices", "Syllabus (each)", 1.0),
    priced("Petitions/Notices", "Amaranth Stationery 5-1/2 x 8-1/2 (pad)", 1.5),

    // ===== PARAPHERNALIA =====
    priced("Paraphernalia", "Ballot Balls, white (per 100)", 5.7),
    priced("Paraphernalia", "Black Cubes (each)", 0.25),
    priced("Paraphernalia", "Black Cubes (each) (additional)", 0.25),

    // ===== CERTIFICATES =====
    priced("Certificates", "25 Year Certificate", 1.0),
    priced("Certificates", "50 Year Certificate", 1.0),
    priced("Certificates", "Honorary Membership #404 Sub Ct (each)", 0.6),
    priced("Certificates", "Honorary Membership #127 Gr Ct (each)", 0.6),
    priced("Certificates", "Life Member #202 (each)", 0.6),

    // ===== BIBLES =====
    requestOnly("Bibles", "White, Altar", "N/A (not stocked)"),

    // ===== SEALS (N/A on the sheet) =====
    requestOnly("Seals", "Gold Seals (each)", "N/A"),

    // ===== CHARTERS =====
    priced("Charters", "Charter, Sub. Ct.", 1.5),

    // ===== COMPUTER DISCS =====
    priced("Computer Discs", "Form Flash Drive", 10.0),

    // ===== FLAG & TOPS =====
    priced('Flag & Tops', 'Eagle, 7" spread (each)', 38.0),
    priced('Flag & Tops', 'Eagle, 6" spread (each)', 20.0),
    priced('Flag & Tops', 'Eagle, 5" spread (each)', 23.0),

    // ===== DISPENSATIONS =====
    priced("Dispensations", "GRM's #302 (per pad)", 4.2),
    priced("Dispensations", "To Organize a Court (each)", 0.75, { requiresCourtInfo: true }),
    priced("Dispensations", "Petition to Organize a Court (each)", 1.1, { requiresCourtInfo: true }),
    priced("Dispensations", "Procedure to Organize a Court (each)", 0.75),

    // ===== PINS =====
    priced("Pins", "25 Year Pins (each)", 5.0),
    priced("Pins", "50 Year Pins (each)", 5.0),

    // ===== JEWELS =====
    priced("Jewels", "Subordinate Court (set of 21)", 490.0),
    priced("Jewels", "Subordinate Court (individual)", 25.0),
    priced("Jewels", "Grand Court (set of 32)", 825.0),
    priced("Jewels", "Grand Court (individual)", 31.25),
    priced("Jewels", "Amaranth (subject to change) - New", 450.0),

    // ===== STANDARDS & BANNERS / FLAGS (sections shown but not priced) =====
    requestOnly("Standards & Banners", "Standard / Banner parts", "Available upon request (not priced)"),
    requestOnly("Standards & Banners", "Banners (Red satin)", "Available upon request (not priced)"),
    requestOnly("Standards & Banners", "Knobs / Tassels / Cords / Rods & Ends", "Available upon request (not priced)"),
    requestOnly("Flags", "Flags", "Listed as a section (no prices shown on this sheet)"),
  ];
})();
