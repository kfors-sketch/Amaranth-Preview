"use strict";

const form = document.getElementById("report-form");
const feedback = form.querySelector(".feedback");
const records = document.getElementById("records");
const kind = document.body.dataset.kind;
const money = cents => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

function paragraph(parent, text) {
  const line = document.createElement("p");
  line.textContent = text;
  parent.append(line);
}

function renderReport(list) {
  records.replaceChildren();
  for (const record of list) {
    const card = document.createElement("article");
    const { purchaser } = record;
    const address = [purchaser.address1, purchaser.address2, purchaser.city, purchaser.state, purchaser.postal, purchaser.country].filter(Boolean).join(", ");
    paragraph(card, purchaser.name + " · " + purchaser.title + " · " + money(record.totalCents) + " · " + record.status);
    paragraph(card, purchaser.email + " · " + purchaser.phone + " · " + address);
    if (record.kind === "store") {
      for (const item of record.items) paragraph(card, item.quantity + " × " + item.name + " (" + item.option + ")");
    } else {
      for (const attendee of record.attendees) {
        paragraph(card, attendee.name + " · " + attendee.assembly + " #" + attendee.assemblyNumber + " · " +
          (attendee.memberType === "voting" ? "Voting" : "Non-Voting") +
          (attendee.lunch ? " · Lunch" : "") + (attendee.notes ? " · " + attendee.notes : ""));
      }
    }
    paragraph(card, new Date(record.createdAt).toLocaleString() + " · " + record.id);
    records.append(card);
  }
}

let token;
async function report(action) {
  const buttons = form.querySelectorAll("button");
  buttons.forEach(button => { button.disabled = true; });
  feedback.textContent = "Loading…";
  delete feedback.dataset.error;
  try {
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
    const response = await fetch("/api/rainbow/orders?action=" + action + "&kind=" + kind, { headers, cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) { token = undefined; records.replaceChildren(); }
      throw new Error((await response.json()).error || "Unable to load the report.");
    }
    if (action === "csv") {
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = kind === "store" ? "rainbow-orders.csv" : "rainbow-registrations.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback.textContent = "CSV downloaded.";
    } else {
      const list = await response.json();
      renderReport(list);
      feedback.textContent = list.length + " paid test submission(s).";
    }
  } catch (error) {
    feedback.textContent = error.message;
    feedback.dataset.error = "";
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

form.addEventListener("submit", event => { event.preventDefault(); report("report"); });
document.getElementById("export").addEventListener("click", () => report("csv"));
