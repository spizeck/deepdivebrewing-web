// Timezone-safe calendar math for the tour inquiry date picker (Issue #102).
// Everything operates on calendar dates — year/month/day fields only. Day
// arithmetic goes through Date.UTC (pure day numbers), never through
// `new Date("YYYY-MM-DD")`, which parses as UTC midnight and shifts the day
// in non-UTC timezones.
import type { CalendarDate } from "./whatsapp";

/** "2026-10-12" — the `<input type="date">` wire format. */
export function toIsoDate(date: CalendarDate): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** Strict ordering on calendar dates: <0, 0, >0. */
export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return (
    Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)
  );
}

/** Add (or subtract) whole days — month/year boundaries handled by UTC math. */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Sunday-first weeks covering the whole month. Leading/trailing cells are
 * null so every week has exactly 7 entries.
 */
export function monthGrid(
  year: number,
  month: number
): (CalendarDate | null)[][] {
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const count = daysInMonth(year, month);
  const cells: (CalendarDate | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: count }, (_, i) => ({
      year,
      month,
      day: i + 1,
    })),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (CalendarDate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1];
}

/** "October 12, 2026" — always with the year, for unambiguous labels. */
export function formatCalendarDate(date: CalendarDate): string {
  return `${monthName(date.month)} ${date.day}, ${date.year}`;
}
