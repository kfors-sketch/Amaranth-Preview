// /assets/js/supplies.js
// Supreme Supplies price list (2026) — transcribed from the provided PDF.
//
// Notes:
// - Items with numeric prices are purchasable now (active: true)
// - Items listed as “Available Upon Request” / “N/A” are included for reference
//   but are NOT purchasable yet (active: false)
// - Some items require extra “court info” at checkout:
//     Court Name, Court Number, Date Organized, Location

(function () {
  const CHAIR_NAME = "HL Patti Baker";
  const CHAIR_EMAIL = "Supremesecretary@amaranth.org";

  const chair = { name: CHAIR_NAME, email: CHAIR_EMAIL };
  const chairEmails = [CHAIR_EMAIL];

  // Helper to make ids consistent and unique.
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
    // Images are optional. Leave blank for now (your UI will show a placeholder).
    image: "",
    images: [],
    // Inventory (0 = unlimited)
    qtyTotal: 0,
    qtySold: 0,
    active: true,
    // Reporting
    chair,
    chairEmails,
    publishStart: "",
    publishEnd: "",
    reportFrequency: "monthly",
    // Shipping/handling placeholder (you said you’ll add later)
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

  // --- Items (keep the order exactly as the PDF) ---
  window.SUPPLIES_ITEMS = [
    // Books
    priced("Books", "Secret Work (each)", 15),
    priced("Books", "Ritual Book (each)", 25),
    priced("Books", "Opening Drill Book (each)", 8),
    priced("Books", "Constitution & Bylaws (each)", 6),
    priced("Books", "Trestleboard (each)", 15),

    // Cards
    priced("Cards", "Mileage (each)", 0.1),
    priced("Cards", "Sick & Distress (each)", 0.1),

    // Certificates
    priced("Certificates", "Original Life Membership (each)", 0.5),
    priced("Certificates", "Honorary Membership (each)", 0.5),
    priced("Certificates", "Annual Membership (each)", 0.5),
    priced("Certificates", "Life Membership (replacement each)", 0.5),
    priced("Certificates", "Honorary Membership (replacement each)", 0.5),

    // Charters
    priced("Charters", "Court Charter with Seal", 15),
    priced("Charters", "Trestleboard Charter", 2.5),

    // Computer Discs
    priced(
      "Computer Discs",
      "District Deputy Book of Instructions (each)",
      25
    ),
    priced("Computer Discs", "Ritual with Music (each)", 25),

    // Dispensations
    priced("Dispensations", "GRM's Dispensation #302 (each)", 15),
    priced("Dispensations", "To Organize a Court (each)", 10, {
      requiresCourtInfo: true,
    }),
    priced("Dispensations", "Petition to Organize a Court (each)", 5, {
      requiresCourtInfo: true,
    }),
    priced("Dispensations", "Procedure to Organize a Court (each)", 10),

    // Flags
    priced("Flags", "Eastern Star (each)", 17),
    priced("Flags", "American Flag (each)", 17),

    // Seals
    // NOTE (from PDF): When ordering a seal, provide Court Name, Court Number,
    // Date Organized and Location.
    priced("Seals", "Court Seal (each)", 30, { requiresCourtInfo: true }),
    priced("Seals", "Court Seal Holder (each)", 30, { requiresCourtInfo: true }),
    priced("Seals", "Trestleboard Seal (each)", 30),
    priced("Seals", "Trestleboard Seal Holder (each)", 30),

    // Standards & Banners
    requestOnly(
      "Standards & Banners",
      "Standards & Banners",
      "Available upon request (not priced in list)"
    ),

    // Staff Tops
    priced("Staff Tops", "GRM Staff Top (each)", 100),
    priced("Staff Tops", "GRP Staff Top (each)", 100),
    priced("Staff Tops", "RDM Staff Top (each)", 40),
    priced("Staff Tops", "RDP Staff Top (each)", 40),
    priced("Staff Tops", "District Deputy Staff Top (each)", 40),

    // Wreaths
    requestOnly("Wreaths", "Wreaths", "Available upon request (not priced in list)"),

    // Histories
    priced("Histories", "Grand Court History Books (each)", 10),
    priced("Histories", "Supreme Court History Books (each)", 35),
    priced("Histories", "District History Books (each)", 15),

    // Letters
    priced("Letters", "Letters of Congratulation (each)", 5),

    // Petition - blanks - notices
    priced("Petition/Blanks/Notices", "Petition to Affiliate (each)", 0.1),
    priced("Petition/Blanks/Notices", "Petition for membership (each)", 0.1),
    priced("Petition/Blanks/Notices", "Demits (each)", 0.1),
    priced("Petition/Blanks/Notices", "Commission (each)", 0.1),
    priced("Petition/Blanks/Notices", "Request for Waiver (each)", 0.1),
    priced("Petition/Blanks/Notices", "Notice of Meeting (each)", 0.1),

    // Paraphernalia
    requestOnly(
      "Paraphernalia",
      "Paraphernalia",
      "Available upon request (not priced in list)"
    ),

    // Bibles
    priced("Bibles", "Bible (each)", 40),

    // Flag & Tops
    priced("Flag & Tops", "State Flag (each)", 25),
    priced("Flag & Tops", "State Flag Top (each)", 35),
    priced("Flag & Tops", "American Flag Top (each)", 35),
    priced("Flag & Tops", "Eastern Star Flag Top (each)", 35),
    priced("Flag & Tops", "Amaranth Flag Top (each)", 35),
    priced("Flag & Tops", "Court Flag Top (each)", 35),

    // Jewels
    requestOnly(
      "Jewels",
      "Jewels",
      "N/A (not available / not priced in list)"
    ),
  ];
})();
