import ExcelJS from "exceljs";

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
    spacerRows = false, // Step 1: add a blank spacer row after each data row
    autoFit = true,     // Step 3: expand columns to the longest value
    minColWidth = 10,
    maxColWidth = 60,
    padding = 2,
  } = options || {};

  const cols = (columns || []).map((key) => ({
    header: headerLabels[key] || key,
    key,
    // initial width; may be overridden by autoFit below
    width: Math.min(maxColWidth, Math.max(minColWidth, String(headerLabels[key] || key).length + padding)),
  }));

  ws.columns = cols;

  for (const r of rows || []) {
    const obj = {};
    for (const c of columns || []) obj[c] = r?.[c] ?? "";
    ws.addRow(obj);
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

// ---------------------------------------------------------------------------
// Receipt XLSX backup sender
// ---------------------------------------------------------------------------


export { objectsToXlsxBuffer };
