// /api/admin/export-utils.js
import ExcelJS from "exceljs";

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// XLSX helper: objects → XLSX buffer
// ---------------------------------------------------------------------------
async function objectsToXlsxBuffer(
  columns,
  rows,
  headerLabels = {},
  sheetName = "Sheet1",
  options = {}
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  const {
    spacerRows = false,
    autoFit = true,
    minColWidth = 10,
    maxColWidth = 60,
    padding = 2,
  } = options || {};

  const cols = (columns || []).map((key) => ({
    header: headerLabels[key] || key,
    key,
    width: Math.min(maxColWidth, Math.max(minColWidth, String(headerLabels[key] || key).length + padding)),
  }));

  ws.columns = cols;

  for (const r of rows || []) {
    const obj = {};
    for (const c of columns || []) obj[c] = r?.[c] ?? "";
    const added = ws.addRow(obj);
    for (const c of columns || []) {
      const v = r?.[c];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const cell = added.getCell(c);
        if (Object.prototype.hasOwnProperty.call(v, "formula")) {
          cell.value = { formula: v.formula, result: v.result ?? undefined };
        }
        if (v.numFmt) cell.numFmt = v.numFmt;
        if (v.font) cell.font = v.font;
        if (v.alignment) cell.alignment = v.alignment;
      }
    }
    if (spacerRows) ws.addRow({});
  }

  ws.getRow(1).font = { bold: true };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, cols.length) },
  };

  if (autoFit) {
    ws.columns.forEach((col) => {
      let longest = 0;

      col.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell?.value;
        let s = "";

        if (v == null) s = "";
        else if (typeof v === "string") s = v;
        else if (typeof v === "number") s = String(v);
        else if (typeof v === "boolean") s = v ? "TRUE" : "FALSE";
        else if (typeof v === "object") {
          if (v.richText) s = v.richText.map((x) => x.text).join("");
          else if (v.text != null) s = String(v.text);
          else if (v.formula) s = String(v.result ?? v.formula);
          else s = String(v);
        } else s = String(v);

        if (s.length > longest) longest = s.length;
      });

      col.width = Math.min(maxColWidth, Math.max(minColWidth, longest + padding));
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

export { buildCSV, buildCSVSelected, objectsToXlsxBuffer };
