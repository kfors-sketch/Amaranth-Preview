// /assets/js/csv.js  (no exports; attaches to window)
(function () {
  function toCSV(rows) {
    // rows: Array<Array<any>> or Array<object> (object keys from first row)
    if (!rows || !rows.length) return '';
    let headers = null, data = [];

    if (Array.isArray(rows[0])) {
      data = rows;
    } else if (typeof rows[0] === 'object') {
      headers = Object.keys(rows[0]);
      data = [
        headers,
        ...rows.map(r => headers.map(h => r[h]))
      ];
    } else {
      return '';
    }

    const esc = (v) => {
      if (v == null) v = '';
      v = String(v);
      // Quote if value contains comma, quote, or newline
      if (/[",\n]/.test(v)) {
        v = '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    };

    return data.map(row => row.map(esc).join(',')).join('\r\n');
  }

  function downloadCSV(filename, rows) {
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'report.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // expose as global
  window.CSV = { toCSV, downloadCSV };
})();
