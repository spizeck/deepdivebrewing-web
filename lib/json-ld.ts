/**
 * Serialize a structured-data object for inline placement inside an HTML
 * `<script type="application/ld+json">` element.
 *
 * Plain `JSON.stringify` leaves `<` literal inside string values. A `<script>`
 * element is raw text to the HTML parser: it is terminated by the first
 * `</script` sequence (ASCII case-insensitive) regardless of JSON quoting, so
 * a stored value like `"</script><script>alert(1)</script>"` would end the
 * element early and inject markup.
 *
 * The fix is the established safe-JSON escape set (the same one used by
 * `serialize-javascript`/`htmlescape`): `<`, `>`, `&`, U+2028, and U+2029 are
 * rewritten as `\uXXXX` escapes.
 *
 * - `<` prevents `</script` terminators and `<script`/`<!--` openers inside
 *   string values — the breakout this helper exists to stop.
 * - `>` keeps a value from emitting `-->` or `]]>` if the JSON is ever placed
 *   inside an HTML comment or CDATA-adjacent context.
 * - `&` is inert inside raw-text script (entities are not decoded there) but
 *   keeps the output safe if it is ever embedded in a non-raw-text context.
 * - U+2028/U+2029 are legal JSON but were JavaScript line terminators before
 *   ES2019; escaping keeps the payload safe if it is ever evaluated as JS.
 *
 * Every replacement is a valid JSON `\uXXXX` escape inside a string literal,
 * so `JSON.parse` returns values identical to the unescaped serialization.
 */
const UNSAFE_JSON_LD_CHARS = /[<>&\u2028\u2029]/g;

const JSON_LD_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(
    UNSAFE_JSON_LD_CHARS,
    (char) => JSON_LD_ESCAPES[char]
  );
}
