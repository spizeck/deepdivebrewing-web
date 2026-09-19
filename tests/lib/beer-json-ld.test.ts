import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { buildBeerJsonLd } from "../../lib/beer-json-ld";
import { serializeJsonLd } from "../../lib/json-ld";
import { siteUrl } from "../../lib/site";

// Commerce/review signals Google requires for product snippets. Beer detail
// pages are informational and cannot truthfully carry any of these — emitting
// a bare `Product` node is what caused the Search Console error (Issue #81).
const FORBIDDEN_KEYS = [
  "offers",
  "review",
  "aggregateRating",
  "price",
  "priceCurrency",
  "availability",
  "sku",
  "gtin",
  "mpn",
];
const FORBIDDEN_TYPES = ["Product", "Offer", "AggregateOffer", "Review", "AggregateRating"];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
  return out;
}

const beer = { name: "Under the Rock", slug: "under-the-rock" };

describe("buildBeerJsonLd", () => {
  const jsonLd = buildBeerJsonLd(beer);

  it("emits a BreadcrumbList that mirrors the visible nav", () => {
    assert.equal(jsonLd["@context"], "https://schema.org");
    assert.equal(jsonLd["@type"], "BreadcrumbList");
    assert.deepEqual(jsonLd.itemListElement, [
      {
        "@type": "ListItem",
        position: 1,
        name: "Our Beers",
        item: `${siteUrl}/beers`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: beer.name,
        item: `${siteUrl}/beers/${beer.slug}`,
      },
    ]);
  });

  it("emits no commerce or review data anywhere in the graph", () => {
    const strings = collectStrings(jsonLd);
    for (const key of [...FORBIDDEN_KEYS, ...FORBIDDEN_TYPES]) {
      assert.equal(
        strings.includes(key),
        false,
        `beer JSON-LD must not contain ${key}`
      );
    }
  });

  it("serializes through serializeJsonLd into parseable, escaped JSON", () => {
    const hostile = { name: `Bad "Beer" </script><script>x</script>`, slug: "bad-beer" };
    const out = serializeJsonLd(buildBeerJsonLd(hostile));
    assert.equal(out.includes("<"), false);
    const parsed = JSON.parse(out);
    assert.equal(parsed.itemListElement[1].name, hostile.name);
  });
});

describe("beer detail page JSON-LD wiring", () => {
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "(pages)", "beers", "[slug]", "page.tsx"),
    "utf8"
  );

  it("does not emit a Google Product rich-result candidate", () => {
    assert.equal(pageSource.includes('"Product"'), false);
    assert.equal(pageSource.includes('"@type": "Product"'), false);
    for (const key of FORBIDDEN_KEYS) {
      assert.equal(
        pageSource.includes(`"${key}"`),
        false,
        `page source still references ${key}`
      );
    }
  });

  it("routes every JSON-LD script through serializeJsonLd", () => {
    const scripts = pageSource.match(/type="application\/ld\+json"/g) ?? [];
    const serializers = pageSource.match(
      /dangerouslySetInnerHTML=\{\{ __html: serializeJsonLd\(/g
    ) ?? [];
    assert.ok(scripts.length > 0, "expected at least one JSON-LD script");
    assert.equal(serializers.length, scripts.length);
    assert.equal(pageSource.includes("JSON.stringify"), false);
  });
});
