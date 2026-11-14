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
const sharedForm = byId("shared-form");
const cart = new Map();
const storageKey = "pa-rainbow-cart";
let draft = { items: [], attendees: [] };

function saveDraft(next) {
  sessionStorage.setItem(storageKey, JSON.stringify(next));
  draft = next;
}

function saveItems() {
  const items = [...cart.values()].map(({ product, option, quantity }) => ({
    id: product.id, option, quantity, name: product.name,
  }));
  saveDraft({ ...draft, items });
}

function attendeeDetails(row) {
  return {
    ...Object.fromEntries([...row.querySelectorAll("[name]")].map(input => [input.name, input.value])),
    events: [...row.querySelectorAll("[data-event]:checked")].map(input => input.value),
  };
}
const attendees = byId("attendees");
let catalog;
let sharedSubtotal = 0;

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
      saveItems();
      updateCartTotal();
    });
    const label = make("label", "Quantity");
    label.append(qty);
    const remove = make("button", "Remove", { type: "button", class: "secondary" });
    remove.addEventListener("click", () => { cart.delete(variant); saveItems(); renderCart(); });
    row.append(make("strong", product.name + " · " + option), label, remove);
    container.append(row);
  }
  if (!cart.size) container.append(make("p", "Your test cart is empty."));
  updateCartTotal();
}

function cartSubtotal() {
  return [...cart.values()].reduce((sum, item) => sum + item.quantity * item.product.cents, 0);
}

function updateCartTotal() {
  const total = cartSubtotal();
  byId("store-total").value = money(total);

}

function renderProducts() {
  if (!catalog.products.length) byId("products").append(make("p", "No merchandise is currently available."));
  for (const product of catalog.products) {
    const card = make("article", "", { class: "product" });
    const option = make("select");
    for (const name of product.options) option.append(make("option", name, { value: name }));
    const label = make("label", "Option");
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
      saveItems();
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
  byId("session-total").value = money(sessionSubtotal());
}

function sessionSubtotal() {
  const selected = [...attendees.querySelectorAll("[data-event]:checked")];
  const extras = selected.reduce((sum, input) => sum + Number(input.dataset.cents), 0);
  return attendees.children.length * catalog.registrationCents + extras;
}

function addAttendee(saved = {}) {
  const row = byId("attendee-template").content.firstElementChild.cloneNode(true);
  const choices = row.querySelector(".attendee-events");
  if (catalog.events.length) choices.append(make("strong", "Optional banquets and events"));
  for (const entry of catalog.events) {
    const label = make("label", "", { class: "check" });
    const checkbox = make("input", "", { type: "checkbox", value: entry.id, "data-event": "", "data-cents": entry.cents });
    checkbox.checked = saved.events?.includes(entry.id) || false;
    checkbox.addEventListener("change", updateAttendees);
    label.append(checkbox, (entry.type === "banquet" ? "Banquet" : "Event") + " · " + entry.name +
      " (" + (entry.cents ? money(entry.cents) : "Free") + ")" + (entry.detail ? " — " + entry.detail : ""));
    choices.append(label);
  }
  row.querySelector("button").addEventListener("click", () => { row.remove(); updateAttendees(); });
  for (const input of row.querySelectorAll("[name]")) {
    if (Object.hasOwn(saved, input.name)) input.value = saved[input.name];
  }
  attendees.append(row);
  updateAttendees();
}

function renderSharedCart() {
  const container = byId("shared-lines");
  container.replaceChildren();
  const products = new Map(catalog.products.map(item => [item.id, item]));
  const events = new Map(catalog.events.map(event => [event.id, event]));
  let total = 0;
  let unavailable = false;

  for (const [index, item] of draft.items.entries()) {
    const product = products.get(item.id);
    const available = product?.options.includes(item.option);
    const cost = available ? product.cents * item.quantity : 0;
    total += cost;
    unavailable ||= !available;
    const row = make("div", "", { class: "cart-line" });
    const remove = make("button", "Remove", { type: "button", class: "secondary" });
    remove.addEventListener("click", () => {
      saveDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) });
      renderSharedCart();
    });
    const quantity = make("input", "", { type: "number", min: 1, max: 10, value: item.quantity });
    quantity.addEventListener("change", () => {
      const count = Math.max(1, Math.min(10, Math.trunc(quantity.valueAsNumber) || 1));
      saveDraft({ ...draft, items: draft.items.map((entry, i) => i === index ? { ...entry, quantity: count } : entry) });
      renderSharedCart();
    });
    const label = make("label", "Quantity");
    label.append(quantity);
    row.append(make("span", (product?.name || item.name) + " (" + item.option + ") · " +
      (available ? money(cost) : "Unavailable")), label, remove);
    container.append(row);
  }

  for (const [index, attendee] of draft.attendees.entries()) {
    const selected = attendee.events.map(id => events.get(id));
    const available = selected.every(Boolean);
    const cost = catalog.registrationCents + selected.reduce((sum, event) => sum + (event?.cents || 0), 0);
    total += cost;
    unavailable ||= !available;
    const row = make("div", "", { class: "cart-line" });
    const details = selected.map(event => event?.name || "Unavailable event");
    const remove = make("button", "Remove attendee", { type: "button", class: "secondary" });
    remove.addEventListener("click", () => {
      saveDraft({ ...draft, attendees: draft.attendees.filter((_, i) => i !== index) });
      renderSharedCart();
    });
    row.append(make("span", attendee.name + " · Annual Session" + (details.length ? " · " + details.join(", ") : "") +
      " · " + money(cost)), remove);
    container.append(row);
  }
  const empty = !draft.items.length && !draft.attendees.length;
  if (empty) container.append(make("p", "Your cart is empty."));
  byId("shared-total").value = money(total);
  sharedForm.hidden = empty;
  sharedForm.querySelector("[type=submit]").disabled = unavailable || !catalog.checkoutEnabled;
  feedback(sharedForm, unavailable ? "Remove unavailable items or edit your Annual Session selections to continue." : "",
    unavailable ? "error" : undefined);
  sharedSubtotal = total;
}

if (sessionForm) byId("add-attendee").addEventListener("click", () => addAttendee());

request("catalog").then((result) => {
  catalog = result;
  draft = JSON.parse(sessionStorage.getItem(storageKey) || "null") || draft;
  if (storeForm) {
    for (const item of draft.items) {
      const product = catalog.products.find(entry => entry.id === item.id && entry.options.includes(item.option));
      if (product) cart.set(item.id + ":" + item.option, { product, option: item.option, quantity: item.quantity });
    }
    renderProducts();
    renderCart();
    storeForm.hidden = false;
  }
  if (sessionForm) {
    for (const attendee of (draft.attendees.length ? draft.attendees : [{}])) addAttendee(attendee);
    sessionForm.hidden = false;
    sessionForm.addEventListener("submit", event => {
      event.preventDefault();
      try {
        saveDraft({ ...draft, attendees: [...attendees.children].map(attendeeDetails) });
        window.location.assign("/rainbow/cart.html");
      } catch {
        feedback(sessionForm, "The cart could not be saved in this browser.", "error");
      }
    });
  }
  if (sharedForm) {
    if (!catalog.checkoutEnabled) {
      byId("load-error").textContent = "Test checkout is currently turned off.";
      byId("load-error").hidden = false;
    }
    renderSharedCart();
    sharedForm.addEventListener("submit", async event => {
      event.preventDefault();
      const controls = [...sharedForm.querySelectorAll("input, button")];
      controls.forEach(control => { control.disabled = true; });
      byId("shared-lines").inert = true;
      feedback(sharedForm, "Opening Stripe test checkout…");
      try {
        const purchaser = Object.fromEntries([...sharedForm.querySelectorAll(".purchaser [name]")]
          .map(input => [input.name, input.value]));
        const items = draft.items.map(({ id, option, quantity }) => ({ id, option, quantity }));
        const payload = { kind: "cart", purchaser, items, attendees: draft.attendees,
          expectedSubtotal: sharedSubtotal };
        const signature = JSON.stringify(payload);
        const id = draft.checkout?.signature === signature ? draft.checkout.id : crypto.randomUUID();
        saveDraft({ ...draft, checkout: { id, signature } });
        const checkout = await request("checkout", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, id }),
        });
        window.location.assign(checkout.url);
      } catch (error) {
        feedback(sharedForm, error.message, "error");
        controls.forEach(control => { control.disabled = false; });
        byId("shared-lines").inert = false;
      }
    });
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
    if (sharedForm) {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (stored?.checkout?.id === record.id) {
        saveDraft({ items: [], attendees: [] });
        if (catalog) renderSharedCart();
      }
    }
    checkoutResult.textContent = "Confirmed • " + money(record.totalCents) + " test payment • Reference " + record.id;
    checkoutResult.dataset.success = "";
    history.replaceState(null, "", window.location.pathname);
  }).catch((error) => {
    checkoutResult.textContent = error.message + " Reload this page to try verification again.";
    checkoutResult.dataset.error = "";
  });
} else if (stripeReturn.has("stripe_cancel")) {
  checkoutResult.hidden = false;
  checkoutResult.textContent = "Stripe checkout was canceled. You can review your selections and try again.";
  history.replaceState(null, "", window.location.pathname);
}
