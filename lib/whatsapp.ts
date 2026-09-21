// WhatsApp deep links for the brewery's inquiry channel (+599 416 3544,
// Saba). wa.me URLs carry an optional pre-filled `text` message;
// encodeURIComponent is applied exactly once here so call sites pass
// readable copy and never hand-encode.
const WHATSAPP_NUMBER = "5994163544";

export function whatsappUrl(message?: string): string {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

export interface TourInquiry {
  // Canonical option name — also the `event_label` for `tour_inquiry_click`.
  label: string;
  // Pre-filled WhatsApp message for this option.
  message: string;
}

// Pre-filled tour inquiries (Issue #87): identify the selected option and
// its published price, note that tours are by request, and prompt for a
// preferred date and party size — conversationally, without implying
// confirmed availability. Prices and option names must stay in sync with
// the published copy on /contact.
export const TOUR_INQUIRY = {
  breweryTour: {
    label: "Brewery Tour",
    message:
      "Hi Deep Dive! I'm interested in the $20 Brewery Tour. Tours are by request. We're looking at [preferred date] for [party size] people. Is that available?",
  },
  breweryTourTasting: {
    label: "Brewery Tour + Tasting",
    message:
      "Hi Deep Dive! I'm interested in the $40 Brewery Tour + Tasting. Tours are by request. We're looking at [preferred date] for [party size] people. Is that available?",
  },
} as const satisfies Record<string, TourInquiry>;
