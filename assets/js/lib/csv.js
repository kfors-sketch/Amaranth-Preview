// /lib/csv.js
const esc = s => {
  const t = String(s ?? "");
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function rowsToCSV(headers, rows){
  return [headers, ...rows].map(r => r.map(esc).join(",")).join("\n");
}
