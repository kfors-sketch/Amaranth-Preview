// /api/admin/tour-reports.js
// Tour report helpers kept separate so router.js/core.js do not grow.

function cleanString(v) {
  return String(v ?? "").trim();
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

export function isTourLine(line = {}) {
  const li = line && typeof line === "object" ? line : {};
  const meta = li.meta && typeof li.meta === "object" ? li.meta : {};
  const cat = cleanString(li.category || meta.itemType || meta.item_type || meta.category).toLowerCase();
  if (cat === "tour" || cat === "tours") return true;
  if (meta.tourRegistration && typeof meta.tourRegistration === "object") return true;
  if (Array.isArray(meta.tourAttendees) && meta.tourAttendees.length) return true;
  if (cleanString(meta.tourId || meta.tourName || meta.cellPhone || meta.mobilityAccessibility)) return true;
  return false;
}

export function extractTourFromMeta(meta = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  const reg = m.tourRegistration && typeof m.tourRegistration === "object" ? m.tourRegistration : null;
  const first = safeArray(m.tourAttendees)[0] || null;
  const src = reg || first || m;

  const cellPhone = cleanString(src.cellPhone || src.phone || m.cellPhone);
  const accessibility = cleanString(src.accessibility || src.mobilityAccessibility || m.accessibility || m.mobilityAccessibility);
  const notes = cleanString(src.notes || m.tourNotes || m.notes || m.itemNote);

  if (!cellPhone && !accessibility && !notes && !cleanString(m.tourId || m.tourName || m.tourDateTime || m.tourLocation)) return null;

  return {
    tourId: cleanString(m.tourId || ""),
    tourName: cleanString(m.tourName || ""),
    tourDateTime: cleanString(m.tourDateTime || ""),
    tourLocation: cleanString(m.tourLocation || ""),
    attendeeName: cleanString(src.attendeeName || m.attendeeName || ""),
    cellPhone,
    accessibility,
    notes,
  };
}

export function tourNotes(t) {
  if (!t) return "";
  const bits = [];
  if (t.cellPhone) bits.push(`Cell: ${t.cellPhone}`);
  if (t.accessibility) bits.push(`Accessibility: ${t.accessibility}`);
  if (t.notes) bits.push(t.notes);
  return bits.filter(Boolean).join("; ");
}

export function tourRowFields(t, meta = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  const tour = t || extractTourFromMeta(m) || {};
  return {
    tour_datetime: tour.tourDateTime || cleanString(m.tourDateTime || ""),
    tour_location: tour.tourLocation || cleanString(m.tourLocation || ""),
    tour_cell_phone: tour.cellPhone || cleanString(m.cellPhone || m.attendeePhone || ""),
    tour_accessibility: tour.accessibility || cleanString(m.accessibility || m.mobilityAccessibility || ""),
    tour_notes: tour.notes || cleanString(m.tourNotes || ""),
  };
}
