"use strict";

const form = document.getElementById("admin-form");
const feedback = form.querySelector(".feedback");
const records = document.getElementById("records");
const editor = document.getElementById("catalog-form");
const money = cents => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const categories = { shop: "Shop item", banquet: "Banquet", event: "Annual Session event" };

const membershipLabels = {
  parent: "Parent", youth: "Youth", youth_leader: "Youth Leader",
  voting: "Voting", non_voting: "Non-Voting",
};

function paragraph(parent, text) {
  const line = document.createElement("p");
  line.textContent = text;
  parent.append(line);
}

function renderReport(list, kind) {
  records.replaceChildren();
  for (const record of list) {
    const card = document.createElement("article");
    const { purchaser } = record;
    const address = [purchaser.address1, purchaser.address2, purchaser.city, purchaser.state, purchaser.postal, purchaser.country].filter(Boolean).join(", ");
    paragraph(card, purchaser.name + " · " + purchaser.title + " · Payment total " + money(record.totalCents) + " · " + record.status);
    paragraph(card, purchaser.email + " · " + purchaser.phone + " · " + address);
    if (kind === "store") {
      for (const item of record.items) paragraph(card, item.quantity + " × " + item.name + " (" + item.option + ")");
    } else {
      for (const attendee of record.attendees) {
        const events = attendee.events?.map(event => event.name).join(", ") ?? (attendee.lunch ? "Annual Session lunch" : "");
        paragraph(card, attendee.name + " · " + attendee.assembly + " #" + attendee.assemblyNumber + " · " +
          (membershipLabels[attendee.memberType] ?? attendee.memberType ?? "") +
          (events ? " · " + events : "") + (attendee.notes ? " · " + attendee.notes : ""));
      }
    }
    paragraph(card, new Date(record.createdAt).toLocaleString() + " · " + record.id);
    records.append(card);
  }
}

let token;
let catalog = new Map();

async function request(action, { body, kind } = {}) {
  const password = form.elements.password.value;
  if (password) {
    const login = await fetch("/api/router?action=admin_login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    const result = await login.json();
    if (!login.ok || !result.token) throw new Error(result.error === "locked_out" ? "Grand admin sign-in is temporarily locked." : "Grand admin sign-in failed.");
    token = result.token;
    form.elements.password.value = "";
  }
  const headers = token ? { Authorization: "Bearer " + token } : Admin.tokenHeader();
  if (body) headers["Content-Type"] = "application/json";
  const url = "/api/rainbow/orders?action=" + action + (kind ? "&kind=" + kind : "");
  const response = await fetch(url, { headers, cache: "no-store", method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    if (response.status === 401) {
      token = undefined;
      records.replaceChildren();
    }
    throw new Error((await response.json()).error || "Unable to complete the request.");
  }
  return action === "csv" ? response.blob() : response.json();
}

async function run(task, status = feedback) {
  const buttons = [...document.querySelectorAll("#admin-form button, #catalog-form button")];
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = "Working…";
  delete status.dataset.error;
  try {
    status.textContent = await task();
  } catch (error) {
    status.textContent = error.message;
    status.dataset.error = "";
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function showEditor(entry) {
  editor.reset();
  const fields = editor.elements;
  fields.id.value = entry?.id || "";
  fields.type.value = entry?.type || "shop";
  fields.type.disabled = Boolean(entry);
  fields.name.value = entry?.name || "";
  fields.price.value = entry ? (entry.cents / 100).toFixed(2) : "";
  fields.detail.value = entry?.detail || "";
  fields.options.value = entry?.type === "shop" ? entry.options.join(", ") : "";
  fields.active.checked = entry?.active ?? true;
  document.getElementById("catalog-heading").textContent = entry ? "Edit entry" : "Add an item or event";
  document.getElementById("catalog-options").hidden = fields.type.value !== "shop";
}

function renderCatalog() {
  records.replaceChildren();
  for (const entry of catalog.values()) {
    const card = document.createElement("article");
    paragraph(card, categories[entry.type] + " · " + entry.name + " · " + money(entry.cents) + (entry.active ? " · Visible" : " · Hidden"));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Edit " + entry.name;
    button.addEventListener("click", () => { showEditor(entry); editor.elements.name.focus(); });
    card.append(button);
    records.append(card);
  }
}

if (editor) {
  const editorStatus = document.createElement("p");
  editorStatus.className = "feedback";
  editorStatus.setAttribute("role", "status");
  editor.append(editorStatus);
  form.addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      const list = await request("manage-catalog");
      catalog = new Map(list.map(entry => [entry.id, entry]));
      editor.hidden = false;
      showEditor();
      renderCatalog();
      return list.length + " catalog entries.";
    });
  });
  editor.elements.type.addEventListener("change", () => {
    document.getElementById("catalog-options").hidden = editor.elements.type.value !== "shop";
  });
  document.getElementById("new-entry").addEventListener("click", () => { showEditor(); editorStatus.textContent = ""; });
  editor.addEventListener("submit", event => {
    event.preventDefault();
    const fields = editor.elements;
    const body = { id: fields.id.value, type: fields.type.value, name: fields.name.value, detail: fields.detail.value,
      cents: Math.round(fields.price.valueAsNumber * 100), active: fields.active.checked,
      options: fields.options.value.split(",").map(option => option.trim()).filter(Boolean) };
    run(async () => {
      const entry = await request("manage-catalog", { body });
      catalog.set(entry.id, entry);
      showEditor(entry);
      renderCatalog();
      return entry.name + " saved.";
    }, editorStatus);
  });
} else {
  form.elements.kind.addEventListener("change", () => { records.replaceChildren(); feedback.textContent = ""; });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const kind = form.elements.kind.value;
    run(async () => {
      const list = await request("report", { kind });
      if (form.elements.kind.value === kind) renderReport(list, kind);
      return list.length + " paid test submission(s).";
    });
  });
  document.getElementById("export").addEventListener("click", () => {
    const kind = form.elements.kind.value;
    run(async () => {
      const url = URL.createObjectURL(await request("csv", { kind }));
      const link = document.createElement("a");
      link.href = url;
      link.download = kind === "store" ? "rainbow-orders.csv" : "rainbow-registrations.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return "CSV downloaded.";
    });
  });
}
