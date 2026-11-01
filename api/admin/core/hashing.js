import crypto from "crypto";

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

function computeOrderHash(order) {
  const o = order && typeof order === "object" ? order : {};
  const clone = { ...o };
  delete clone.hash;
  delete clone.hashVersion;
  delete clone.hashCreatedAt;
  const normalized = stableStringify(clone);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function attachImmutableOrderHash(order) {
  const hashCreatedAt = new Date().toISOString();
  const next = { ...order, hashVersion: 1, hashCreatedAt };
  next.hash = computeOrderHash(next);
  return next;
}

function verifyOrderHash(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "not-object" };
  if (!order.hash || !order.hashVersion) return { ok: false, reason: "missing-hash" };
  const expected = computeOrderHash(order);
  return { ok: expected === order.hash, expected, actual: order.hash };
}

// ---------------------------------------------------------------------------
// ADMIN PATCH HELPERS (legacy data fixes)
// - Some early/older orders may be missing court name/# on attendee metadata.
// - We patch lines[].meta fields in a consistent way so reports/export work.
// - After patching, we re-hash the order so "Verify hash" reflects the new
//   admin-approved stored state (and we record patch metadata on the order).
// ---------------------------------------------------------------------------

function setIfBlankOrOverwrite(target, key, val, overwrite) {
  if (!target || typeof target !== "object") return;
  const v = String(val ?? "").trim();
  if (!v) return;
  const cur = String(target[key] ?? "").trim();
  if (overwrite || !cur) target[key] = v;
}

// Exported so router.js can reuse the same normalization.
export function patchOrderCourtFields(order, { courtName = "", courtNo = "", overwrite = false } = {}) {
  const o = order && typeof order === "object" ? { ...order } : null;
  if (!o) return null;

  // Purchaser (optional; some UIs may want this later)
  if (o.purchaser && typeof o.purchaser === "object") {
    setIfBlankOrOverwrite(o.purchaser, "courtName", courtName, overwrite);
    setIfBlankOrOverwrite(o.purchaser, "courtNo", courtNo, overwrite);
    setIfBlankOrOverwrite(o.purchaser, "court", courtName, overwrite);
    setIfBlankOrOverwrite(o.purchaser, "court_number", courtNo, overwrite);
  }

  // Lines / attendee meta
  const lines = Array.isArray(o.lines) ? o.lines.map((ln) => ({ ...ln })) : [];
  for (const ln of lines) {
    ln.meta = ln.meta && typeof ln.meta === "object" ? { ...ln.meta } : {};

    // Court name (write several aliases for compatibility)
    setIfBlankOrOverwrite(ln.meta, "attendeeCourt", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtName", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_name", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "courtName", courtName, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court_name", courtName, overwrite);

    // Court number
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtNumber", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtNo", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendeeCourtNum", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_number", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_no", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "attendee_court_num", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "courtNumber", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "courtNo", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court_no", courtNo, overwrite);
    setIfBlankOrOverwrite(ln.meta, "court_number", courtNo, overwrite);
  }
  o.lines = lines;
  return o;
}

export function rehashOrderAfterAdminPatch(order, { patchedBy = "", patchNote = "" } = {}) {
  if (!order || typeof order !== "object") return order;
  const next = { ...order };
  next.admin_patched = true;
  next.admin_patched_at = new Date().toISOString();
  if (patchedBy) next.admin_patched_by = String(patchedBy).trim();
  if (patchNote) next.admin_patch_note = String(patchNote).trim();

  // Refresh the embedded hash to match the new stored state.
  next.hashVersion = 1;
  next.hashCreatedAt = new Date().toISOString();
  next.hash = computeOrderHash(next);
  return next;
}

// ---------------------------------------------------------------------------
// LOCKDOWN MODE (block write actions during live/event week)
// ---------------------------------------------------------------------------


export {
  stableStringify,
  computeOrderHash,
  attachImmutableOrderHash,
  verifyOrderHash,
};
