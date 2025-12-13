// /assets/js/banquets.js
// Simpler schema: each banquet has a single top-level price (no options array).
// Fields kept for reporting/email registration: id, name, chairEmails, publishStart, publishEnd.
//
// ✅ Added ordering support:
// - sortOrder: number (lower shows first on admin + public, when those pages sort by it)
// - eventAt: ISO datetime (optional but recommended; helps stable sorting + future filtering)
// - slotKey/slotLabel/slotScope + reportFrequency preserved for YoY + reports consistency
//
// NOTE: This file is the STATIC FALLBACK list (window.BANQUETS). If your server /api/router?type=banquets
// returns banquets from KV, that server list will be used first. This fallback still needs to be correct.

window.BANQUETS = [
  {
    id: "trails-feast",
    name: "Trails & Treasures Feast",
    datetime: "Saturday, April 18th at 5 PM",
    eventAt: "2026-04-18T17:00:00.000Z",
    sortOrder: 10,
    location: "Court Room",
    description: "YADA YADA",
    price: 60, // single price
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "gf-officers-breakfast",
    name: "Grand Floor Officers Breakfast",
    datetime: "Sunday, April 19th at 9 AM",
    eventAt: "2026-04-19T09:00:00.000Z",
    sortOrder: 20,
    location: "Palm Court",
    description: "Plated Breakfast",
    price: 25,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "past-grands-luncheon",
    name: "Past Grands Luncheon",
    datetime: "Sunday, April 19th at 12 PM",
    eventAt: "2026-04-19T12:00:00.000Z",
    sortOrder: 30,
    location: "Tea Room",
    description: "BLAH BLAH",
    price: 60,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "supreme-luncheon",
    name: "Supreme Luncheon",
    datetime: "Monday, April 20th at 12 PM",
    eventAt: "2026-04-20T12:00:00.000Z",
    sortOrder: 40,
    location: "Palm Court",
    description: "Yada Blah",
    price: 35,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "adventure-banquet",
    name: "What an Adventure Banquet",
    datetime: "Monday, April 20th at 5 PM",
    eventAt: "2026-04-20T17:00:00.000Z",
    sortOrder: 50,
    location: "Palm Court",
    description: "Blah Yada",
    price: 60,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "breakfast-2",
    name: "Breakfast",
    datetime: "Tuesday, April 21st at 9 AM",
    eventAt: "2026-04-21T09:00:00.000Z",
    sortOrder: 60,
    location: "Palm Court",
    description:
      "For DDGRMs, Grand Representatives, Pages, Grand Choir, Secretaries and Treasurers",
    price: 25,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "fly-eagles-fly-banquet",
    name: "Fly Eagles FLY Banquet",
    datetime: "Tuesday, April 21st at 12 PM",
    eventAt: "2026-04-21T12:00:00.000Z",
    sortOrder: 70,
    location: "Palm Court",
    description: "",
    price: 55,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "breakfast-3",
    name: "Breakfast",
    datetime: "Wednesday, April 22nd at 9 AM",
    eventAt: "2026-04-22T09:00:00.000Z",
    sortOrder: 80,
    location: "Palm Court",
    description:
      "For Grand Floor Officers, DDGRMs and Grand Representatives",
    price: 25,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "banquet-09",
    name: "Banquet 09",
    datetime: "TBD",
    eventAt: "",
    sortOrder: 90,
    location: "TBD",
    description: "",
    price: 25,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "banquet-10",
    name: "Banquet 10",
    datetime: "TBD",
    eventAt: "",
    sortOrder: 100,
    location: "TBD",
    description: "",
    price: 55,
    mealChoices: ["Pasta", "Chicken", "Vegetarian"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "banquet-11",
    name: "Banquet 11",
    datetime: "TBD",
    eventAt: "",
    sortOrder: 110,
    location: "TBD",
    description: "",
    price: 35,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  },

  {
    id: "banquet-12",
    name: "Banquet 12",
    datetime: "TBD",
    eventAt: "",
    sortOrder: 120,
    location: "TBD",
    description: "",
    price: 65,
    mealChoices: ["Beef", "Chicken", "Vegan"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"],
    reportFrequency: "monthly",
    slotScope: "banquet",
    slotKey: "",
    slotLabel: ""
  }
];

/* ===== Auto-register metadata for email reports (banquets) ===== */
(function () {
  try {
    const isAdmin =
      typeof location !== "undefined" && location.pathname.startsWith("/admin/");
    const token =
      typeof localStorage !== "undefined" && localStorage.getItem("amaranth_report_token");
    if (!isAdmin || !token) return;

    const ENDPOINT =
      (typeof window !== "undefined" && window.AMARANTH_REGISTER_ENDPOINT) ||
      "/api/router?action=register_item";

    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token
    };

    (window.BANQUETS || []).forEach((b) => {
      const emails = Array.isArray(b.chairEmails)
        ? b.chairEmails.filter(Boolean)
        : [b?.chair?.email].filter(Boolean);

      const payload = {
        id: b.id,
        name: b.name,
        publishStart: b.publishStart || "",
        publishEnd: b.publishEnd || "",
        reportFrequency: (b.reportFrequency || "monthly"),
        slotScope: (b.slotScope || "banquet"),
        slotKey: (b.slotKey || ""),
        slotLabel: (b.slotLabel || ""),
        // helpful for sorting on the server later
        sortOrder: (typeof b.sortOrder === "number" ? b.sortOrder : undefined),
        eventAt: (b.eventAt || "")
      };

      if (emails.length > 0) payload.chairEmails = emails;

      fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    });
  } catch {
    // silent
  }
})();
