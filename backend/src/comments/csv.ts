/**
 * RFC 4180 CSV for the analytics exports (M6-T6, D12 b). Starts with a UTF-8 BOM so Excel reads
 * Bangla text, rows end with CRLF, and a text cell that a spreadsheet would run as a formula
 * (`= + - @`, tab, CR) gets a leading `'` (OWASP CSV injection guard). Numbers are written as is.
 */

export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(
  header: readonly string[],
  rows: Iterable<readonly CsvCell[]>,
): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
