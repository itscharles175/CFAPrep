export function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows = []) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function downloadTextFile(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename, rows) {
  downloadTextFile(filename, rowsToCsv(rows), 'text/csv');
}
