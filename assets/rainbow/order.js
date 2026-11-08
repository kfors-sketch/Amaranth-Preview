"use strict";

const byId = (id) => document.getElementById(id);
const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const make = (tag, text, attributes = {}) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};

async function request(action, options) {
  const response = await fetch("/api/rainbow/orders?action=" + action, options);
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "The request failed. Try again.");
  }
  return response.json();
}

function feedback(form, message, type) {
  const target = form.querySelector(".feedback");
  target.textContent = message;
  delete target.dataset.error;
  delete target.dataset.success;
  if (type) target.dataset[type] = "";
}

const storeForm = byId("store-form");
const sessionForm = byId("session-form");
const cart = new Map();
const attendees = byId("attendees");
let catalog;

function renderCart() {
  const container = byId("cart");
  container.replaceChildren();
  for (const [variant, { product, option, quantity }] of cart) {
    const row = make("div", "", { class: "cart-line" });
    const qty = make("input", "", { type: "number", min: 1, max: 10, value: quantity });
    qty.addEventListener("change", () => {
      const current = cart.get(variant);
      if (!current) return;
      current.quantity = Math.max(1, Math.min(10, Math.trunc(qty.valueAsNumber) || 1));
      qty.value = current.quantity;
      updateCartTotal();
    });
    const label = make("label", "Quantity");
    label.append(qty);
    const remove = make("button", "Remove", { type: "button", class: "secondary" });
    remove.addEventListener("click", () => { cart.delete(variant); renderCart(); });
    row.append(make("strong", product.name + " · " + option), label, remove);
    container.append(row);
  }
  if (!cart.size) container.append(make("p", "Your test cart is empty."));
  updateCartTotal();
}

function updateCartTotal() {
  const total = [...cart.values()].reduce((sum, item) => sum + item.quantity * item.product.cents, 0);
  byId("store-total").value = money(total);
  storeForm.querySelector("[type=submit]").disabled = !cart.size || !catalog.checkoutEnabled;
}

function renderProducts() {
  for (const product of catalog.products) {
    const card = make("article", "", { class: "product" });
    const option = make("select");
    for (const name of product.options) option.append(make("option", name, { value: name }));
    const label = make("label", product.options.length > 1 ? "Size" : "Option");
    label.append(option);
    const add = make("button", "Add to cart", { type: "button" });
    add.addEventListener("click", () => {
      const variant = product.id + ":" + option.value;
      const quantity = cart.get(variant)?.quantity || 0;
      if (quantity === 10) {
        feedback(storeForm, "You can add up to 10 of each option.", "error");
        return;
      }
      cart.set(variant, { product, option: option.value, quantity: quantity + 1 });
      renderCart();
      feedback(storeForm, product.name + " added to your cart.", "success");
    });
    card.append(make("h3", product.name), make("p", product.detail), make("strong", money(product.cents)), label, add);
    byId("products").append(card);
  }
}

function updateAttendees() {
  const rows = [...attendees.children];
  rows.forEach((row, index) => {
    row.querySelector("legend").textContent = "Attendee " + (index + 1);
    row.querySelector("button").hidden = rows.length === 1;
  });
  byId("add-attendee").disabled = rows.length >= 6;
  const lunches = attendees.querySelectorAll("[name=lunch]:checked").length;
  byId("session-total").value = money(rows.length * catalog.registrationCents + lunches * catalog.lunchCents);
}

function addAttendee() {
  const row = byId("attendee-template").content.firstElementChild.cloneNode(true);
  row.querySelector(".lunch-label").textContent = "Add sample lunch (" + money(catalog.lunchCents) + ")";
  row.querySelector("[name=lunch]").addEventListener("change", updateAttendees);
  row.querySelector("button").addEventListener("click", () => { row.remove(); updateAttendees(); });
  attendees.append(row);
  updateAttendees();
}

function bindCheckout(form, kind, details) {
  let previousBody;
  let id;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = [...form.querySelectorAll(".purchaser [name]")];
    const purchaser = Object.fromEntries(fields.map(input => [input.name, input.value]));
    const payload = { kind, purchaser, ...details() };
    const signature = JSON.stringify(payload);
    if (signature !== previousBody) id = crypto.randomUUID();
    previousBody = signature;
    const controls = [...form.querySelectorAll("input, select, button")].filter(control => !control.disabled);
    controls.forEach(control => { control.disabled = true; });
    if (kind === "store") byId("products").inert = true;
    feedback(form, "Opening Stripe test checkout…");
    try {
      const checkout = await request("checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, id }),
      });
      window.location.assign(checkout.url);
    } catch (error) {
      feedback(form, error.message, "error");
    } finally {
      controls.forEach(control => { control.disabled = false; });
      if (kind === "store") byId("products").inert = false;
    }
  });
}

if (sessionForm) byId("add-attendee").addEventListener("click", addAttendee);

if (storeForm || sessionForm) request("catalog").then((result) => {
  catalog = result;
  if (!catalog.checkoutEnabled) {
    const notice = byId("load-error");
    notice.textContent = "You can preview these forms now. Test checkout is currently turned off.";
    notice.hidden = false;
  }
  if (storeForm) {
    renderProducts();
    renderCart();
    storeForm.hidden = false;
    bindCheckout(storeForm, "store", () => ({
      items: [...cart.values()].map(({ product, option, quantity }) => ({ id: product.id, option, quantity })),
    }));
  }
  if (sessionForm) {
    addAttendee();
    sessionForm.hidden = false;
    sessionForm.querySelector("[type=submit]").disabled = !catalog.checkoutEnabled;
    bindCheckout(sessionForm, "session", () => ({
      attendees: [...attendees.children].map(row => Object.fromEntries(
        [...row.querySelectorAll("[name]")].map(input => [input.name, input.type === "checkbox" ? input.checked : input.value]))),
    }));
  }
}).catch((error) => {
  byId("load-error").textContent = error.message;
  byId("load-error").hidden = false;
});

const stripeReturn = new URLSearchParams(window.location.search);
const checkoutResult = byId("checkout-result");
if (stripeReturn.has("stripe_session")) {
  checkoutResult.hidden = false;
  checkoutResult.textContent = "Verifying your Stripe test payment…";
  request("confirm", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: stripeReturn.get("stripe_session") }),
  }).then((record) => {
    checkoutResult.textContent = "Confirmed • " + money(record.totalCents) + " test payment • Reference " + record.id;
    checkoutResult.dataset.success = "";
    history.replaceState(null, "", window.location.pathname);
  }).catch((error) => {
    checkoutResult.textContent = error.message + " Reload this page to try verification again.";
    checkoutResult.dataset.error = "";
  });
} else if (stripeReturn.has("stripe_cancel")) {
  checkoutResult.hidden = false;
  checkoutResult.textContent = "Stripe checkout was canceled. Start a new test order or registration below.";
  history.replaceState(null, "", window.location.pathname);
}
