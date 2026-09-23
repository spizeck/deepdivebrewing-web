import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_LEGAL_NAME,
  BUSINESS_NAME,
  SOCIAL_URLS,
  resolveSiteUrl,
  siteUrl,
} from "../../lib/site";

describe("resolveSiteUrl", () => {
  it("defaults to the canonical apex origin", () => {
    assert.equal(resolveSiteUrl(undefined), "https://deepdivebrewing.com");
  });

  it("passes an override through unchanged", () => {
    assert.equal(resolveSiteUrl("https://example.com"), "https://example.com");
  });

  it("strips trailing slashes so callers can append paths safely", () => {
    assert.equal(
      resolveSiteUrl("https://example.com/"),
      "https://example.com"
    );
    assert.equal(
      resolveSiteUrl("https://example.com///"),
      "https://example.com"
    );
  });
});

describe("siteUrl", () => {
  it("resolves to an absolute https origin without a trailing slash", () => {
    assert.match(siteUrl, /^https:\/\/[^/]+$/);
  });
});

// Canonical business facts (Issue #107) — pinned so an accidental edit here
// surfaces as a test failure, since JSON-LD, mailto links, and footer
// profiles all read from these constants.
describe("business constants", () => {
  it("pins the canonical business facts", () => {
    assert.equal(BUSINESS_NAME, "Deep Dive Brewing Co");
    assert.equal(BUSINESS_LEGAL_NAME, "Deep Dive Brews, BV");
    assert.equal(BUSINESS_EMAIL, "info@deepdivebrewing.com");
    assert.deepEqual(BUSINESS_ADDRESS, {
      streetAddress: "66 Fort Bay Road",
      addressLocality: "The Bottom",
      addressCountry: "BQ",
    });
    assert.deepEqual(SOCIAL_URLS, {
      instagram: "https://www.instagram.com/deepdivebrewing",
      facebook: "https://www.facebook.com/deepdivebrewing",
      untappd: "https://untappd.com/DeepDiveBrewingCo",
    });
  });
});
