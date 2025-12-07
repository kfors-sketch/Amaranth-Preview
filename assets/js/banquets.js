// /assets/js/banquets.js
// Simpler schema: each banquet has a single top-level price (no options array).
// Fields kept for reporting/email registration: id, name, chairEmails, publishStart, publishEnd.

window.BANQUETS = [
  {
    id: "trails-feast",
    name: "Trails & Treasures Feast",
    datetime: "Saturday, April 18th at 5 PM",
    location: "Court Room",
    description: "YADA YADA",
    price: 60, // single price
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"]
  },

  {
    id: "gf-officers-breakfast",
    name: "Grand Floor Officers Breakfast",
    datetime: "Sunday, April 19th at 9 AM",
    location: "Palm Court",
    description: "Plated Breakfast",
    price: 25,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"]
  },

  {
    id: "past-grands-luncheon",
    name: "Past Grands Luncheon",
    datetime: "Sunday, April 19th at 12 PM",
    location: "Tea Room",
    description: "BLAH BLAH",
    price: 60,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "mrskfors@yahoo.com" },
    chairEmails: ["mrskfors@yahoo.com"]
  },

  {
    id: "supreme-luncheon",
    name: "Supreme Luncheon",
    datetime: "Monday, April 20th at 12 PM",
    location: "Palm Court",
    description: "Yada Blah",
    price: 35,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "adventure-banquet",
    name: "What an Adventure Banquet",
    datetime: "Monday, April 20th at 5 PM",
    location: "Palm Court",
    description: "Blah Yada",
    price: 60,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "breakfast-2",
    name: "Breakfast",
    datetime: "Tuesday, April 21st at 9 AM",
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
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "fly-eagles-fly-banquet",
    name: "Fly Eagles FLY Banquet",
    datetime: "Tuesday, April 21st at 12 PM",
    location: "Palm Court",
    description: "",
    price: 55,
    mealChoices: ["Chicken Entrée", "Beef Entrée", "Vegetarian Entrée"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "breakfast-3",
    name: "Breakfast",
    datetime: "Wednesday, April 22nd at 9 AM",
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
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "banquet-09",
    name: "Banquet 09",
    datetime: "TBD",
    location: "TBD",
    description: "",
    price: 25,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "banquet-10",
    name: "Banquet 10",
    datetime: "TBD",
    location: "TBD",
    description: "",
    price: 55,
    mealChoices: ["Pasta", "Chicken", "Vegetarian"],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "banquet-11",
    name: "Banquet 11",
    datetime: "TBD",
    location: "TBD",
    description: "",
    price: 35,
    mealChoices: [],
    dietary: [],
    active: true,
    publishStart: "",
    publishEnd: "",
    chair: { name: "TBD", email: "tbd@example.com" },
    chairEmails: ["tbd@example.com"]
  },

  {
    id: "banquet-12",
    name: "Banquet 12",
    datetime: "TBD",
    location: "TBD",
    description: "",
    price: 65,
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
      // Match items.js behavior: derive emails and only send if non-empty
      const emails = Array.isArray(b.chairEmails)
        ? b.chairEmails.filter(Boolean)
        : [b?.chair?.email].filter(Boolean);

      const payload = {
        id: b.id,
        name: b.name,
        publishStart: b.publishStart || "",
        publishEnd: b.publishEnd || ""
      };

      if (emails.length > 0) {
        payload.chairEmails = emails;
      }

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
