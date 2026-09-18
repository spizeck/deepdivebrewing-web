import { describe, it } from "node:test";
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serializeJsonLd } from "../../lib/json-ld";

const SCRIPT_BREAKOUT = "</script><script>alert(1)</script>";

// The HTML parser ends a raw-text <script> element at the first "</script"
// (ASCII case-insensitive) regardless of JSON string quoting.
const SCRIPT_END = /<\/script/i;

describe("serializeJsonLd", () => {
  it("serializes normal structured data identically to JSON.stringify", () => {
    const data = {
      "@context": "https://schema.org",
      "@type": "Brewery",
      name: "Deep Dive Brewing Co",
      areaServed: ["Saba", "SXM"],
      telephone: "+599-416-3544",
    };
    assert.equal(serializeJsonLd(data), JSON.stringify(data));
  });

  it("produces valid JSON that round-trips to identical values", () => {
    const data = {
      "@type": "Product",
      name: "Island <Dive> & \"Deep\" Lager",
      nested: { notes: ["citrus", "malt"], abv: 5.2, ibu: null },
      flag: true,
    };
    const parsed = JSON.parse(serializeJsonLd(data));
    assert.deepEqual(parsed, data);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(data)));
  });

  it("escapes every '<' so no script terminator can appear in the output", () => {
    const out = serializeJsonLd({ name: "a < b", close: "</script>" });
    assert.equal(out.includes("<"), false);
    assert.equal(SCRIPT_END.test(out), false);
  });

  it("neutralizes a bare </script> string value", () => {
    const out = serializeJsonLd({ description: "</script>" });
    assert.equal(out.includes("</script"), false);
    assert.equal(out.includes("<"), false);
    // The value still decodes to the original characters after JSON.parse.
    assert.equal(JSON.parse(out).description, "</script>");
  });

  it("prevents a </script><script> payload from forming a second element", () => {
    const out = serializeJsonLd({ name: SCRIPT_BREAKOUT });
    // No literal '<' means the HTML parser sees a single uninterrupted
    // script-data run — the payload is inert JSON text, not markup.
    assert.equal(out.includes("<"), false);
    assert.equal(SCRIPT_END.test(out), false);
    assert.equal(out.includes("\\u003c/script\\u003e"), true);
  });

  it("escapes '>' and '&' per the safe-JSON escape set", () => {
    const out = serializeJsonLd({ text: "a > b & c --> ]]>" });
    assert.equal(out.includes(">"), false);
    assert.equal(out.includes("&"), false);
  });

  it("escapes U+2028 and U+2029 line separators", () => {
    const out = serializeJsonLd({ text: "line\u2028one\u2029two" });
    assert.equal(out.includes("\u2028"), false);
    assert.equal(out.includes("\u2029"), false);
    assert.equal(out.includes("\\u2028"), true);
    assert.equal(out.includes("\\u2029"), true);
  });

  it("preserves quotes, backslashes, and normal Unicode through a round trip", () => {
    const text = 'quote " backslash \\ newline\n é ü 🍺 中文';
    const out = serializeJsonLd({ text });
    assert.equal(JSON.parse(out).text, text);
  });

  it("handles numbers, booleans, null, and arrays", () => {
    const data = { n: 4.5, ok: false, nothing: null, list: [1, "two", null] };
    assert.deepEqual(JSON.parse(serializeJsonLd(data)), data);
  });

  it("throws a clear error for top-level values JSON cannot represent", () => {
    for (const value of [undefined, () => {}, Symbol("x")]) {
      assert.throws(() => serializeJsonLd(value), TypeError);
    }
  });
});

describe("JSON-LD script render path", () => {
  it("keeps an admin-controlled beer name inside the script element", () => {
    // Mirrors the Product JSON-LD built by app/(pages)/beers/[slug]/page.tsx:
    // beer.name comes from Firestore and is admin-managed.
    const beerJsonLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: SCRIPT_BREAKOUT,
      description: `Brewed on Saba. ${SCRIPT_BREAKOUT}`,
    };

    const html = renderToStaticMarkup(
      createElement("script", {
        type: "application/ld+json",
        dangerouslySetInnerHTML: { __html: serializeJsonLd(beerJsonLd) },
      })
    );

    // Exactly one script element: the payload cannot open a second one or
    // close this one early.
    assert.equal((html.match(/<script/g) ?? []).length, 1);
    assert.equal((html.match(/<\/script/gi) ?? []).length, 1);

    // The script body is still valid JSON carrying the original values.
    const body = html.slice(
      html.indexOf(">") + 1,
      html.toLowerCase().lastIndexOf("</script")
    );
    const parsed = JSON.parse(body) as { name: string; description: string };
    assert.equal(parsed.name, SCRIPT_BREAKOUT);
    assert.equal(parsed.description, `Brewed on Saba. ${SCRIPT_BREAKOUT}`);
  });
});
