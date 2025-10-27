// assets/js/banquets.js
// NOTE:
// - `chair` and `chairEmails` added to each banquet.
// - The emailing system will treat `publishEnd` as the "ordering closes" date for final reports.

window.BANQUETS = [
  // 01 — Has meal choices
  {
    id: "trails-feast",
    name: "Trails & Treasures Feast",
    datetime: "Saturday, April 18th at 5 PM",
    location: "Court Room",
    description: "YADA YADA",
    options: [{ id: "adult", label: "Ticket", price: 60 }],
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 02 — No meal choices
  {
    id: "gf-officers-breakfast",
    name: "Grand Floor Officers Breakfast",
    datetime: "Sunday, April 19th at 9 AM",
    location: "Palm Court",
    description: "Plated Breakfast",
    options: [{ id: "adult", label: "Ticket", price: 25 }],
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 03 — Has meal choices
  {
    id: "past-grands-luncheon",
    name: "Past Grands Luncheon",
    datetime: "Sunday, April 19th at 12 PM",
    location: "Tea Room",
    description: "BLAH BLAH",
    options: [{ id: "adult", label: "Ticket", price: 60 }],
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 04 — Has meal choices
  {
    id: "supreme-luncheon",
    name: "Supreme Luncheon",
    datetime: "Monday, April 20th at 12 PM",
    location: "Palm Court",
    description: "Yada Blah",
    options: [{ id: "adult", label: "Ticket", price: 35 }],
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 05 — Has meal choices
  {
    id: "adventure-banquet",
    name: "What an Adventure Banquet",
    datetime: "Monday, April 20th at 5 PM",
    location: "Palm Court",
    description: "Blah Yada",
    options: [{ id: "ticket", label: "Ticket", price: 60 }],
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 06 — No meal choice
  {
    id: "breakfast-2",
    name: "Breakfast",
    datetime: "Tuesday, April 21st at 9 AM",
    location: "Palm Court",
    description: "For DDGRMs, Grand Representatives, Pages, Grand Choir, Secretaries and Treasurers",
    options: [{ id: "ticket", label: "Ticket", price: 25 }],
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 07 — Has meal choices
  {
    id: "fly-eagles-fly-banquet",
    name: "Fly Eagles FLY Banquet",
    datetime: "Tuesday, April 21st at 12 PM",
    location: "Palm Court",
    description: "",
    options: [{ id: "ticket", label: "Ticket", price: 55 }],
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 08 — No meal choice
  {
    id: "breakfast-3",
    name: "Breakfast",
    datetime: "Wednesday, April 22nd at 9 AM",
    location: "Palm Court",
    description: "For Grand Floor Officers, DDGRMs and Grand Representatives",
    options: [{ id: "ticket", label: "Ticket", price: 25 }],
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 09 — Placeholder (no meal choice)
  {
    id: "banquet-09",
    name: "Banquet 09",
    datetime: "TBD",
    location: "TBD",
    description: "",
    options: [{ id: "ticket", label: "Ticket", price: 25 }],
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 10 — Placeholder with meal choices
  {
    id: "banquet-10",
    name: "Banquet 10",
    datetime: "TBD",
    location: "TBD",
    description: "",
    options: [{ id: "ticket", label: "Ticket", price: 55 }],
    mealChoices: ["Pasta", "Chicken", "Vegetarian"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 11 — Placeholder (no meal choice)
  {
    id: "banquet-11",
    name: "Banquet 11",
    datetime: "TBD",
    location: "TBD",
    description: "",
    options: [{ id: "ticket", label: "Ticket", price: 35 }],
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  // 12 — Placeholder with meal choices
  {
    id: "banquet-12",
    name: "Banquet 12",
    datetime: "TBD",
    location: "TBD",
    description: "",
    options: [{ id: "ticket", label: "Ticket", price: 65 }],
    mealChoices: ["Beef", "Chicken", "Vegan"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  }
];

/* ===== Auto-register metadata for email reports (banquets) ===== */
(function () {
  try {
    // Only auto-register on admin pages AND when a token exists
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
      const payload = {
        id: b.id,
        name: b.name,
        chairEmails: Array.isArray(b.chairEmails)
          ? b.chairEmails
          : [b?.chair?.email].filter(Boolean),
        publishStart: b.publishStart || "",
        publishEnd: b.publishEnd || "" // treated as "ordering closes" for FINAL reports
      };

      // Fire-and-forget; suppress any errors
      fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    });
  } catch {
    // intentionally silent to avoid noisy consoles on public pages
  }
})();
