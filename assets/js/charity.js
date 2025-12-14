// assets/js/supplies.js
// Charity category items (works just like assets/js/items.js, but separate list + images folder)
//
// ID convention (recommended): "charity:<unique-item-id>"
// Example: "charity:embroidered-patch"
//
// Images folder (recommended): /assets/shop-charity/
//
// NOTE: If there are NO active items, the supplies page will hide itself (handled in supplies.html).

window.CHARITY_ITEMS = [
  // Example item (delete or edit as needed):
  /*
  {
    id: "charity:example-item",
    name: "Example Charity Item",

    // NEW: Sort Order (lower shows first)
    sortOrder: 10,

    // Single-price item
    price: 25, // dollars (item price, not shipping)

    // Per-order shipping & handling for this item (in cents).
    // Checkout logic will charge the HIGHEST shippingCents from all items in the cart, once per order.
    shippingCents: 550, // $5.50 shipping & handling

    // Thumbnail shown on the page
    image: "",

    // Optional: lightbox gallery images (full-size)
    images: [],

    sku: "SUP-001",

    // Inventory (optional)
    qtyTotal: 0, // 0 (or omit) = unlimited
    qtySold: 0,  // must be present; pages update this as people buy

    // Visibility + publish window (optional)
    active: true,
    publishStart: "", // ISO string or "" (optional)
    publishEnd: "",   // ISO string or "" (optional)

    // ===== reporting fields =====
    chair: { name: "Charity", email: "" }, // email managed via admin
    chairEmails: [],                         // emails come from KV/admin
    reportFrequency: "monthly",              // monthly/weekly/biweekly/daily (optional)
  }
  */
];

// -----------------------------------------------------------------------------
// Auto-register active items for chair reports + YoY indexing (same idea as items.js)
// This is safe even if chairEmails is empty.
// -----------------------------------------------------------------------------
(function autoRegisterCharityItems() {
  try {
    const list = Array.isArray(window.CHARITY_ITEMS) ? window.CHARITY_ITEMS : [];
    if (!list.length) return;

    // Only register items that are "active" (and have an id+name)
    const active = list.filter((it) => it && it.active !== false && it.id && it.name);
    if (!active.length) return;

    active.forEach((it) => {
      const payload = {
        id: String(it.id || "").trim(),
        name: String(it.name || "").trim(),
        kind: "catalog", // keep using catalog pipeline (reports/Yoy/scheduler)
        publishStart: String(it.publishStart || ""),
        publishEnd: String(it.publishEnd || ""),
        reportFrequency: String(it.reportFrequency || it.report_frequency || "monthly"),
      };

      // chairEmails can be: it.chairEmails OR it.chair.email
      const emails = Array.isArray(it.chairEmails)
        ? it.chairEmails
        : String(it.chairEmails || it?.chair?.email || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

      if (emails.length) payload.chairEmails = emails;

      fetch("/api/router?action=register_item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    });
  } catch (e) {
    console.warn("[supplies] auto-register failed:", e);
  }
})();
