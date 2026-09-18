import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveSiteUrl, siteUrl } from "../../lib/site";

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
