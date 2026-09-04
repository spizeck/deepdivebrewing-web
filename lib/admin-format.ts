/**
 * Client-safe formatters for administrative values.
 *
 * These helpers are intentionally lenient so that malformed or missing server
 * data never produces UI errors such as "Invalid Date".
 */

export function formatAdminDate(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Unknown";

  const asString = typeof value === "number" ? String(value) : String(value);
  if (!asString || asString === "undefined") return "Unknown";

  const date = new Date(asString);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString();
}

export function formatAdminDateTime(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Unknown";

  const asString = typeof value === "number" ? String(value) : String(value);
  if (!asString || asString === "undefined") return "Unknown";

  const date = new Date(asString);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}
