import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  TOUR_PRODUCTS,
  buildTourInquiryMessage,
  formatInquiryDate,
  isPastDate,
  parseCalendarDate,
  validateTourInquiry,
  whatsappUrl,
  type CalendarDate,
} from "../../lib/whatsapp";

const NUMBER = "5994163544";
const TODAY: CalendarDate = { year: 2026, month: 10, day: 8 };

// Parses the generated wa.me URL and returns the decoded `text` param —
// one decode, so a double-encoded URL would surface as leftover "%" here.
function decodeMessage(url: string): string {
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://wa.me");
  assert.equal(parsed.pathname, `/${NUMBER}`);
  const text = parsed.searchParams.get("text");
  assert.ok(text, "URL must carry a pre-filled text message");
  return text;
}

function validInquiry(overrides: Partial<{ date: string; partySize: string }> = {}) {
  const result = validateTourInquiry(
    { date: "2026-10-12", partySize: "2", ...overrides },
    TODAY
  );
  assert.ok(result.ok, "expected a valid inquiry");
  return result.value;
}

describe("whatsappUrl", () => {
  it("targets the brewery WhatsApp number", () => {
    for (const product of Object.values(TOUR_PRODUCTS)) {
      const message = buildTourInquiryMessage(
        product,
        validInquiry(),
        new Date(2026, 9, 8)
      );
      assert.ok(
        whatsappUrl(message).startsWith(`https://wa.me/${NUMBER}?text=`)
      );
    }
  });

  it("encodes the message exactly once and decodes back verbatim", () => {
    const message = buildTourInquiryMessage(
      TOUR_PRODUCTS.breweryTour,
      validInquiry(),
      new Date(2026, 9, 8)
    );
    const url = whatsappUrl(message);
    // No raw spaces and no double encoding (%25 = an encoded "%").
    assert.ok(!url.includes(" "));
    assert.ok(!url.includes("%25"));
    assert.equal(decodeMessage(url), message);
    assert.equal(decodeURIComponent(url.split("text=")[1]), message);
  });

  it("returns the bare number link without a message", () => {
    assert.equal(whatsappUrl(), `https://wa.me/${NUMBER}`);
  });
});

describe("tour products", () => {
  it("Brewery Tour is $20 and about 30 minutes", () => {
    assert.equal(TOUR_PRODUCTS.breweryTour.label, "Brewery Tour");
    assert.equal(TOUR_PRODUCTS.breweryTour.priceUsd, 20);
    assert.equal(TOUR_PRODUCTS.breweryTour.durationLabel, "About 30 minutes");
  });

  it("Brewery Tour + Tasting is $40 and about 60 minutes", () => {
    assert.equal(
      TOUR_PRODUCTS.breweryTourTasting.label,
      "Brewery Tour + Tasting"
    );
    assert.equal(TOUR_PRODUCTS.breweryTourTasting.priceUsd, 40);
    assert.equal(
      TOUR_PRODUCTS.breweryTourTasting.durationLabel,
      "About 60 minutes"
    );
  });

  it("labels double as the canonical tour_inquiry_click event_label", () => {
    assert.equal(TOUR_PRODUCTS.breweryTour.label, "Brewery Tour");
    assert.equal(
      TOUR_PRODUCTS.breweryTourTasting.label,
      "Brewery Tour + Tasting"
    );
  });
});

describe("parseCalendarDate", () => {
  it("parses an input[type=date] value into year/month/day", () => {
    assert.deepEqual(parseCalendarDate("2026-10-12"), {
      year: 2026,
      month: 10,
      day: 12,
    });
  });

  it("rejects empty, malformed, and impossible values", () => {
    for (const value of [
      "",
      "   ",
      "abc",
      "10/12/2026",
      "2026-10",
      "2026-13-01",
      "2026-00-10",
      "2026-10-32",
      "2026-02-30",
      "2026-10-12T00:00:00Z",
    ]) {
      assert.equal(parseCalendarDate(value), null, value);
    }
  });
});

describe("isPastDate", () => {
  it("rejects yesterday but allows today and tomorrow", () => {
    assert.ok(isPastDate({ year: 2026, month: 10, day: 7 }, TODAY));
    assert.ok(!isPastDate({ year: 2026, month: 10, day: 8 }, TODAY));
    assert.ok(!isPastDate({ year: 2026, month: 10, day: 9 }, TODAY));
  });
});

describe("formatInquiryDate", () => {
  it("renders a friendly same-year date without a timezone shift", () => {
    // "2026-10-12" must stay October 12 — parsing it as UTC midnight would
    // shift it a day in negative-offset timezones.
    const date = parseCalendarDate("2026-10-12")!;
    assert.equal(formatInquiryDate(date, TODAY), "October 12");
  });

  it("adds the year when the date is in a different calendar year", () => {
    const date = parseCalendarDate("2027-01-03")!;
    assert.equal(formatInquiryDate(date, TODAY), "January 3, 2027");
  });
});

describe("validateTourInquiry", () => {
  it("requires a preferred date", () => {
    const result = validateTourInquiry({ date: "", partySize: "2" }, TODAY);
    assert.ok(!result.ok);
    assert.match(result.errors.date ?? "", /preferred date/i);
  });

  it("rejects a malformed date", () => {
    const result = validateTourInquiry(
      { date: "Oct 12", partySize: "2" },
      TODAY
    );
    assert.ok(!result.ok);
    assert.ok(result.errors.date);
  });

  it("rejects a past date", () => {
    const result = validateTourInquiry(
      { date: "2026-10-07", partySize: "2" },
      TODAY
    );
    assert.ok(!result.ok);
    assert.match(result.errors.date ?? "", /today or a future/i);
  });

  it("allows today", () => {
    const result = validateTourInquiry(
      { date: "2026-10-08", partySize: "2" },
      TODAY
    );
    assert.ok(result.ok);
  });

  it("requires a party size", () => {
    const result = validateTourInquiry(
      { date: "2026-10-12", partySize: "" },
      TODAY
    );
    assert.ok(!result.ok);
    assert.match(result.errors.partySize ?? "", /party size/i);
  });

  it("rejects zero, negative, non-integer, and non-numeric party sizes", () => {
    for (const partySize of ["0", "-2", "2.5", "abc"]) {
      const result = validateTourInquiry(
        { date: "2026-10-12", partySize },
        TODAY
      );
      assert.ok(!result.ok, partySize);
      assert.ok(result.errors.partySize, partySize);
    }
  });

  it("accepts a valid party size", () => {
    assert.equal(validInquiry({ partySize: "4" }).partySize, 4);
    assert.equal(validInquiry({ partySize: " 3 " }).partySize, 3);
  });
});

describe("buildTourInquiryMessage", () => {
  const now = new Date(2026, 9, 8); // October 8, 2026 (local)

  it("Brewery Tour names the option, price, party size, and date", () => {
    const message = buildTourInquiryMessage(
      TOUR_PRODUCTS.breweryTour,
      validInquiry({ date: "2026-10-12", partySize: "2" }),
      now
    );
    assert.equal(
      message,
      "Hi Deep Dive! I'm interested in the $20 Brewery Tour for 2 people on October 12. Is that available?"
    );
  });

  it("Brewery Tour + Tasting names the option, price, party size, and date", () => {
    const message = buildTourInquiryMessage(
      TOUR_PRODUCTS.breweryTourTasting,
      validInquiry({ date: "2026-10-08", partySize: "4" }),
      now
    );
    assert.equal(
      message,
      "Hi Deep Dive! I'm interested in the $40 Brewery Tour + Tasting for 4 people on October 8. Is that available?"
    );
  });

  it("uses the singular for a party of one", () => {
    const message = buildTourInquiryMessage(
      TOUR_PRODUCTS.breweryTour,
      validInquiry({ partySize: "1" }),
      now
    );
    assert.ok(message.includes("for 1 person on"));
  });

  it("asks about availability and carries no placeholders", () => {
    for (const product of Object.values(TOUR_PRODUCTS)) {
      const message = buildTourInquiryMessage(
        product,
        validInquiry(),
        now
      );
      assert.match(message, /Is that available\?$/);
      assert.ok(!message.includes("["));
      assert.ok(!message.includes("]"));
      assert.ok(!/free/i.test(message));
      // No em dash in customer-facing copy.
      assert.ok(!message.includes("—"));
    }
  });
});

describe("contact page tour CTAs", () => {
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "(pages)", "contact", "page.tsx"),
    "utf8"
  );
  const ctaSource = fs.readFileSync(
    path.join(process.cwd(), "components", "tour-inquiry-cta.tsx"),
    "utf8"
  );

  it("open the inquiry modal for each product instead of linking directly", () => {
    const tours = pageSource.slice(pageSource.indexOf("brewery-tours"));
    assert.ok(tours.includes('tour="breweryTour"'));
    assert.ok(tours.includes('tour="breweryTourTasting"'));
    // No hand-encoded or bare-number URLs in the tour section.
    assert.ok(!tours.includes('href="https://wa.me/'));
  });

  it("fires tour_inquiry_click only from the Continue handoff", () => {
    // The opener must not carry delegated data-analytics-event attributes —
    // that would count opening the modal as a completed inquiry.
    assert.ok(!ctaSource.includes('data-analytics-event="tour_inquiry_click"'));
    assert.ok(ctaSource.includes('trackEvent("tour_inquiry_click"'));
    assert.ok(ctaSource.includes('event_category: "conversion"'));
    assert.ok(ctaSource.includes('cta_location: "contact_page_tours"'));
    assert.ok(ctaSource.includes("event_label: product.label"));
  });

  it("hands off through the canonical whatsappUrl helper", () => {
    assert.ok(ctaSource.includes("whatsappUrl(buildTourInquiryMessage("));
    // No hand-built wa.me strings in the component.
    assert.ok(!ctaSource.includes('"https://wa.me/'));
  });
});
