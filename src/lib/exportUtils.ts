export type CsvCell = string | number | boolean | null | undefined;
export type CsvRow = CsvCell[];

export function csvEscape(value: CsvCell): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows: CsvRow[] = []): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function downloadTextFile(filename: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename: string, rows: CsvRow[]): void {
  downloadTextFile(filename, rowsToCsv(rows), 'text/csv');
}
