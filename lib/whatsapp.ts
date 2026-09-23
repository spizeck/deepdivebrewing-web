// WhatsApp deep links for the brewery's inquiry channel (+599 416 3544,
// Saba). wa.me URLs carry an optional pre-filled `text` message;
// encodeURIComponent is applied exactly once here so call sites pass
// readable copy and never hand-encode.
const WHATSAPP_NUMBER = "5994163544";

// Display form of the same number — "+599" is the Caribbean Netherlands
// country code, then the local digits grouped 3-4. Derived from
// WHATSAPP_NUMBER so the digits exist in exactly one place; used for the
// schema `telephone` field and visible contact links.
export const TELEPHONE_DISPLAY = `+${WHATSAPP_NUMBER.slice(0, 3)}-${WHATSAPP_NUMBER.slice(3, 6)}-${WHATSAPP_NUMBER.slice(6)}`;

export function whatsappUrl(message?: string): string {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

// Tour inquiry products (Issues #87/#102). `label` is the canonical option
// name and the `event_label` for `tour_inquiry_click`; `priceUsd` and
// `durationLabel` must stay in sync with the published copy on /contact.
export interface TourProduct {
  label: string;
  priceUsd: number;
  durationLabel: string;
}

export const TOUR_PRODUCTS = {
  breweryTour: {
    label: "Brewery Tour",
    priceUsd: 20,
    durationLabel: "About 30 minutes",
  },
  breweryTourTasting: {
    label: "Brewery Tour + Tasting",
    priceUsd: 40,
    durationLabel: "About 60 minutes",
  },
} as const satisfies Record<string, TourProduct>;

export type TourProductKey = keyof typeof TOUR_PRODUCTS;

// A calendar date — year/month/day fields only. Date-only values must never
// round-trip through `new Date("YYYY-MM-DD")`, which parses as UTC midnight
// and shifts the day in negative-offset timezones.
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Parse an `<input type="date">` value ("YYYY-MM-DD") into a calendar date.
 * Returns null for empty, malformed, or impossible dates (e.g. Feb 30).
 */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through a local Date only to reject impossible dates — the
  // returned value stays field-based and timezone-free.
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Today's calendar date in the visitor's local timezone. */
export function todayCalendarDate(now: Date = new Date()): CalendarDate {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
}

// Day-number comparison — exact, timezone-free.
function dayNumber(d: CalendarDate): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
}

export function isPastDate(
  date: CalendarDate,
  today: CalendarDate = todayCalendarDate()
): boolean {
  return dayNumber(date) < dayNumber(today);
}

/**
 * "October 12" for a date in the current year; "October 12, 2027" once it
 * crosses a calendar-year boundary so the message stays unambiguous.
 */
export function formatInquiryDate(
  date: CalendarDate,
  today: CalendarDate = todayCalendarDate()
): string {
  return new Date(date.year, date.month - 1, date.day).toLocaleDateString(
    "en-US",
    {
      month: "long",
      day: "numeric",
      ...(date.year !== today.year ? { year: "numeric" as const } : {}),
    }
  );
}

export interface TourInquiryInput {
  /** Raw `<input type="date">` value. */
  date: string;
  /** Raw `<input type="number">` value. */
  partySize: string;
}

export interface TourInquiryErrors {
  date?: string;
  partySize?: string;
}

export interface ValidTourInquiry {
  date: CalendarDate;
  partySize: number;
}

/**
 * Validates the modal's raw input. Preferred date is required, a real
 * calendar date, and not in the past (same-day inquiries are allowed).
 * Party size is a required whole number >= 1 — no invented capacity cap.
 */
export function validateTourInquiry(
  input: TourInquiryInput,
  today: CalendarDate = todayCalendarDate()
): { ok: true; value: ValidTourInquiry } | { ok: false; errors: TourInquiryErrors } {
  const errors: TourInquiryErrors = {};

  const dateRaw = input.date.trim();
  const date = parseCalendarDate(dateRaw);
  if (!dateRaw) {
    errors.date = "Choose a preferred date.";
  } else if (!date) {
    errors.date = "Enter a valid date.";
  } else if (isPastDate(date, today)) {
    errors.date = "Choose today or a future date.";
  }

  const sizeRaw = input.partySize.trim();
  const partySize = Number(sizeRaw);
  if (!sizeRaw) {
    errors.partySize = "Enter your party size.";
  } else if (!Number.isInteger(partySize) || partySize < 1) {
    errors.partySize = "Party size must be a whole number of at least 1.";
  }

  if (errors.date || errors.partySize) {
    return { ok: false, errors };
  }
  return { ok: true, value: { date: date!, partySize } };
}

/**
 * The pre-filled WhatsApp message for a validated inquiry: names the selected
 * option, its published price, the party size, and the preferred date, framed
 * as an availability request — never a reservation.
 */
export function buildTourInquiryMessage(
  product: TourProduct,
  inquiry: ValidTourInquiry,
  today?: Date
): string {
  const date = formatInquiryDate(
    inquiry.date,
    today ? todayCalendarDate(today) : undefined
  );
  const party =
    inquiry.partySize === 1 ? "1 person" : `${inquiry.partySize} people`;
  return `Hi Deep Dive! I'm interested in the $${product.priceUsd} ${product.label} for ${party} on ${date}. Is that available?`;
}
