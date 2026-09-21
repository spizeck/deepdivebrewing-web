import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { whatsappUrl, TOUR_INQUIRY } from "../../lib/whatsapp";

const NUMBER = "5994163544";

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

describe("whatsappUrl", () => {
  it("targets the brewery WhatsApp number", () => {
    for (const option of Object.values(TOUR_INQUIRY)) {
      assert.ok(
        whatsappUrl(option.message).startsWith(`https://wa.me/${NUMBER}?text=`)
      );
    }
  });

  it("encodes the message exactly once and decodes back verbatim", () => {
    for (const option of Object.values(TOUR_INQUIRY)) {
      const url = whatsappUrl(option.message);
      // No raw spaces and no double encoding (%25 = an encoded "%").
      assert.ok(!url.includes(" "));
      assert.ok(!url.includes("%25"));
      assert.equal(decodeMessage(url), option.message);
      assert.equal(decodeURIComponent(url.split("text=")[1]), option.message);
    }
  });

  it("returns the bare number link without a message", () => {
    assert.equal(whatsappUrl(), `https://wa.me/${NUMBER}`);
  });
});

describe("tour inquiry messages", () => {
  it("Brewery Tour identifies the option and its $20 price", () => {
    const message = TOUR_INQUIRY.breweryTour.message;
    assert.ok(message.includes("$20"));
    assert.ok(message.includes("Brewery Tour"));
    assert.ok(!message.includes("$40"));
    assert.ok(!message.includes("Tasting"));
  });

  it("Brewery Tour + Tasting identifies the option and its $40 price", () => {
    const message = TOUR_INQUIRY.breweryTourTasting.message;
    assert.ok(message.includes("$40"));
    assert.ok(message.includes("Brewery Tour + Tasting"));
    assert.ok(!message.includes("$20"));
    // The tasting is priced, never described as free.
    assert.ok(!/free/i.test(message));
  });

  it("both messages convey by-request, and prompt for date and party size", () => {
    for (const option of Object.values(TOUR_INQUIRY)) {
      assert.match(option.message, /by request/i);
      assert.match(option.message, /preferred date/i);
      assert.match(option.message, /party size/i);
      // Asks about availability rather than implying it is confirmed.
      assert.match(option.message, /available\?/i);
    }
  });

  it("keeps the canonical analytics labels in sync", () => {
    assert.equal(TOUR_INQUIRY.breweryTour.label, "Brewery Tour");
    assert.equal(TOUR_INQUIRY.breweryTourTasting.label, "Brewery Tour + Tasting");
  });
});

describe("contact page tour CTAs", () => {
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "(pages)", "contact", "page.tsx"),
    "utf8"
  );

  it("route both CTAs through whatsappUrl with distinct option messages", () => {
    assert.ok(
      pageSource.includes(
        "href={whatsappUrl(TOUR_INQUIRY.breweryTour.message)}"
      )
    );
    assert.ok(
      pageSource.includes(
        "href={whatsappUrl(TOUR_INQUIRY.breweryTourTasting.message)}"
      )
    );
    // No hand-encoded or bare-number URLs in the tour section.
    const tours = pageSource.slice(pageSource.indexOf("brewery-tours"));
    assert.ok(!tours.includes('href="https://wa.me/'));
  });

  it("preserve the tour_inquiry_click analytics contract unchanged", () => {
    const tours = pageSource.slice(pageSource.indexOf("brewery-tours"));
    assert.equal(
      (tours.match(/data-analytics-event="tour_inquiry_click"/g) ?? []).length,
      2
    );
    assert.equal(
      (tours.match(/data-analytics-event-category="conversion"/g) ?? []).length,
      2
    );
    assert.equal(
      (tours.match(/data-analytics-cta-location="contact_page_tours"/g) ?? [])
        .length,
      2
    );
    assert.ok(
      tours.includes(
        "data-analytics-event-label={TOUR_INQUIRY.breweryTour.label}"
      )
    );
    assert.ok(
      tours.includes(
        "data-analytics-event-label={TOUR_INQUIRY.breweryTourTasting.label}"
      )
    );
  });
});
