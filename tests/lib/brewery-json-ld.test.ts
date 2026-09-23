import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { buildBreweryJsonLd } from "../../lib/brewery-json-ld";
import { serializeJsonLd } from "../../lib/json-ld";
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_LEGAL_NAME,
  BUSINESS_NAME,
  SOCIAL_URLS,
  siteUrl,
} from "../../lib/site";
import { TELEPHONE_DISPLAY } from "../../lib/whatsapp";

// The four routes that emit the Brewery entity (Issue #107). Each must use
// the shared builder — a hand-written copy is how the field sets diverged.
const BREWERY_PAGES = [
  ["app", "page.tsx"],
  ["app", "(pages)", "contact", "page.tsx"],
  ["app", "(pages)", "trade", "page.tsx"],
  ["app", "(pages)", "where-to-buy", "page.tsx"],
] as const;

describe("buildBreweryJsonLd", () => {
  const jsonLd = buildBreweryJsonLd();

  it("emits the canonical Brewery entity id", () => {
    assert.equal(jsonLd["@context"], "https://schema.org");
    assert.equal(jsonLd["@type"], "Brewery");
    assert.equal(jsonLd["@id"], `${siteUrl}/#brewery`);
  });

  it("carries the complete field set — no field lost in consolidation", () => {
    assert.deepEqual(
      Object.keys(jsonLd).sort(),
      [
        "@context",
        "@id",
        "@type",
        "address",
        "areaServed",
        "description",
        "email",
        "image",
        "legalName",
        "name",
        "openingHoursSpecification",
        "sameAs",
        "telephone",
        "url",
      ].sort()
    );
  });

  it("draws every shared fact from the canonical constants", () => {
    assert.equal(jsonLd.name, BUSINESS_NAME);
    assert.equal(jsonLd.legalName, BUSINESS_LEGAL_NAME);
    assert.equal(jsonLd.url, siteUrl);
    assert.equal(jsonLd.image, `${siteUrl}/photos/og-default.jpg`);
    assert.equal(jsonLd.email, BUSINESS_EMAIL);
    // The schema telephone is the same number as the WhatsApp line — it is
    // derived in lib/whatsapp.ts, not restated here.
    assert.equal(jsonLd.telephone, TELEPHONE_DISPLAY);
    assert.equal(jsonLd.telephone, "+599-416-3544");
    assert.deepEqual(jsonLd.address, {
      "@type": "PostalAddress",
      streetAddress: BUSINESS_ADDRESS.streetAddress,
      addressLocality: BUSINESS_ADDRESS.addressLocality,
      addressCountry: BUSINESS_ADDRESS.addressCountry,
    });
    assert.deepEqual(jsonLd.sameAs, [
      SOCIAL_URLS.instagram,
      SOCIAL_URLS.facebook,
      SOCIAL_URLS.untappd,
    ]);
  });

  it("keeps the full areaServed and opening-hours coverage", () => {
    assert.deepEqual(jsonLd.areaServed, [
      "Saba",
      "Sint Maarten",
      "Saint Martin",
      "SXM",
      "Sint Eustatius",
      "Statia",
    ]);
    assert.deepEqual(jsonLd.openingHoursSpecification, [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        opens: "08:00",
        closes: "15:00",
      },
    ]);
  });

  it("returns a fresh object each call", () => {
    const other = buildBreweryJsonLd();
    assert.notEqual(jsonLd, other);
    assert.deepEqual(jsonLd, other);
  });

  it("serializes through serializeJsonLd into parseable, escaped JSON", () => {
    const out = serializeJsonLd(jsonLd);
    assert.equal(out.includes("<"), false);
    assert.deepEqual(JSON.parse(out), jsonLd);
  });
});

describe("Brewery JSON-LD page wiring", () => {
  const sources = BREWERY_PAGES.map(
    (segments) =>
      [
        segments.join("/"),
        fs.readFileSync(path.join(process.cwd(), ...segments), "utf8"),
      ] as const
  );

  it("every Brewery-schema page uses the shared builder", () => {
    for (const [name, source] of sources) {
      assert.ok(
        source.includes("buildBreweryJsonLd()"),
        `${name} must call buildBreweryJsonLd()`
      );
      // No hand-written Brewery object may survive beside the builder.
      assert.equal(
        source.includes('"@type": "Brewery"'),
        false,
        `${name} still inlines a Brewery object`
      );
      assert.equal(
        source.includes("#brewery"),
        false,
        `${name} still builds the @id locally`
      );
    }
  });

  it("routes every JSON-LD script through serializeJsonLd", () => {
    for (const [name, source] of sources) {
      const scripts = source.match(/type="application\/ld\+json"/g) ?? [];
      const serializers = source.match(
        /dangerouslySetInnerHTML=\{\{ __html: serializeJsonLd\(/g
      ) ?? [];
      assert.ok(scripts.length > 0, `${name} expected a JSON-LD script`);
      assert.equal(
        serializers.length,
        scripts.length,
        `${name} has a JSON-LD script bypassing serializeJsonLd`
      );
      assert.equal(source.includes("JSON.stringify"), false);
    }
  });

  it("keeps page-specific schema local", () => {
    const whereToBuy = sources.find(([name]) =>
      name.includes("where-to-buy")
    )![1];
    // FAQPage mirrors the page's own visible FAQ — it must not move into
    // the shared Brewery builder.
    assert.ok(whereToBuy.includes('"@type": "FAQPage"'));
    assert.equal(
      JSON.stringify(buildBreweryJsonLd()).includes("FAQPage"),
      false
    );
  });

  it("no page restates shared business facts as literals", () => {
    for (const [name, source] of sources) {
      for (const literal of [
        '"https://wa.me/',
        '"mailto:',
        '"tel:',
        '"info@deepdivebrewing.com"',
        '"+599-416-3544"',
        '"66 Fort Bay Road"',
        "streetAddress:",
      ]) {
        assert.equal(
          source.includes(literal),
          false,
          `${name} still carries literal ${literal}`
        );
      }
    }
  });
});
