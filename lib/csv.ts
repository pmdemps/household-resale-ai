// CSV writer with spreadsheet formula-injection protection.
// Cells starting with = + - @ (or tab/CR) are prefixed with ' so Excel/Sheets treat them as text.

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? String(value) : String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 correctly.
  return "﻿" + [header, ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
