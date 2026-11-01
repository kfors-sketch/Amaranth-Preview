function buildCSV(rows) {
  if (!Array.isArray(rows) || !rows.length) return "\uFEFF";
  const headers = Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.join(",")];
  for (const r of rows) out.push(headers.map((h) => esc(r[h])).join(","));
  return "\uFEFF" + out.join("\n");
}

function buildCSVSelected(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.join(",")];
  for (const r of rows || []) out.push(headers.map((h) => esc(r?.[h])).join(","));
  return "\uFEFF" + out.join("\n");
}

export { buildCSV, buildCSVSelected };
