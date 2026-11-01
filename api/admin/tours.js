// /api/admin/tours.js
// Small helper module for Supreme Tours so router.js stays thin.

import {
  kvGetSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvHsetSafe,
  kvSaddSafe,
  normalizeReportFrequency,
} from "./core.js";

const TOURS_KEY = "tours";

function splitEmails(v) {
  if (Array.isArray(v)) return v.map((s) => String(s || "").trim()).filter(Boolean);
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickNonEmptyString(a, b, fallback = "") {
  const aa = String(a ?? "").trim();
  if (aa) return aa;
  const bb = String(b ?? "").trim();
  if (bb) return bb;
  return fallback;
}

function normalizeTour(t) {
  const out = { ...(t || {}) };
  out.id = String(out.id || "").trim();
  out.name = String(out.name || out.title || out.id || "Tour").trim();
  out.description = String(out.description || out.notes || "").trim();
  out.location = String(out.location || out.meetingLocation || "").trim();
  out.tourDateTime = String(out.tourDateTime || out.dateTime || out.start || "").trim();
  out.price = Number(out.price || 0) || 0;
  out.active = out.active !== false;
  out.publishStart = out.publishStart || "";
  out.publishEnd = out.publishEnd || "";
  out.sortOrder = out.sortOrder == null || out.sortOrder === "" ? null : Number(out.sortOrder);
  if (out.sortOrder != null && !Number.isFinite(out.sortOrder)) out.sortOrder = null;
  out.maxQty = Math.max(1, Number(out.maxQty || 1) || 1);
  out.limitPerAttendee = Math.max(0, Number(out.limitPerAttendee || out.limit || 0) || 0);
  out.chairEmails = splitEmails(out.chairEmails || out?.chair?.email || "");
  out.chair = out.chair && typeof out.chair === "object" ? { ...out.chair } : {};
  out.chair.name = String(out.chair.name || "").trim();
  out.chair.email = String(out.chair.email || out.chairEmails[0] || "").trim();
  out.reportFrequency = normalizeReportFrequency(out.reportFrequency || out.report_frequency || "monthly");
  out.type = "tour";
  out.category = "tour";
  return out;
}

export async function loadTours() {
  const list = (await kvGetSafe(TOURS_KEY, [])) || [];
  return Array.isArray(list) ? list.map(normalizeTour) : [];
}

export async function saveToursAndItemCfg(toursInput) {
  const list = (Array.isArray(toursInput) ? toursInput : []).map(normalizeTour);
  await kvSetSafe(TOURS_KEY, list);

  for (const t of list) {
    const id = String(t?.id || "").trim();
    if (!id) continue;

    const existing = await kvHgetallSafe(`itemcfg:${id}`);
    const chairEmails = t.chairEmails.length
      ? t.chairEmails
      : Array.isArray(existing?.chairEmails)
      ? existing.chairEmails
      : splitEmails(existing?.chairEmails || "");

    const cfg = {
      ...existing,
      id,
      name: pickNonEmptyString(t.name, existing?.name, id),
      kind: "tour",
      category: "tour",
      chairEmails,
      publishStart: pickNonEmptyString(t.publishStart, existing?.publishStart, ""),
      publishEnd: pickNonEmptyString(t.publishEnd, existing?.publishEnd, ""),
      reportFrequency: normalizeReportFrequency(t.reportFrequency || existing?.reportFrequency || "monthly"),
      updatedAt: new Date().toISOString(),
    };

    await kvHsetSafe(`itemcfg:${id}`, cfg);
    await kvSaddSafe("itemcfg:index", id);
  }

  return list;
}
