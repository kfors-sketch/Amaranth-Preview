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
    options: [
      { id: "adult", label: "Ticket", price: 60 },
    ],
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
    options: [
      { id: "adult", label: "Ticket", price: 60 },
    ],
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

/* ===== Auto-register metadata for email reports (banquets) — token-gated with debug ===== */
(function(){
  try{
    const token = localStorage.getItem('amaranth_report_token');
    if (!token) {
      console.debug('[banquets/register] skipped: no token in localStorage');
      return; // public pages won’t attempt admin calls
    }

    const list = Array.isArray(window.BANQUETS) ? window.BANQUETS : [];
    if (!list.length) {
      console.debug('[banquets/register] skipped: empty BANQUETS list');
      return;
    }

    let sent = 0;
    list.forEach(b => {
      const payload = {
        id: b.id,
        name: b.name,
        chairEmails: Array.isArray(b.chairEmails) ? b.chairEmails : [b?.chair?.email].filter(Boolean),
        publishStart: b.publishStart || "",
        publishEnd: b.publishEnd || ""   // treated as "ordering closes" for FINAL reports
      };

      // Quick validation/log
      if (!payload.id || !/^[a-z0-9-]+$/.test(payload.id)) {
        console.warn('[banquets/register] skip invalid id:', payload);
        return;
      }
      if (!payload.name) {
        console.warn('[banquets/register] skip missing name:', payload);
        return;
      }

      fetch("/api/admin/register-item", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(payload),
        keepalive: true
      })
      .then(async (r) => {
        const txt = await r.text().catch(()=> '');
        let json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch {}
        if (!r.ok) {
          console.error('[banquets/register] fail', payload.id, r.status, json || txt);
          return;
        }
        console.debug('[banquets/register] success', payload.id, json);
      })
      .catch(err => {
        console.error('[banquets/register] network error', payload.id, err);
      });

      sent++;
    });

    console.debug('[banquets/register] queued', sent, 'items');
  } catch(e){
    console.warn("[banquets/register] auto-register skipped:", e);
  }
})();
