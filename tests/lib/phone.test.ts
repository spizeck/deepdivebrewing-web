import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizePhoneNumber,
  telHref,
  whatsappHref,
} from "@/lib/phone";

// Issue #152 — phone/WhatsApp values arrive as free text ("+599 416 3544",
// "(721) 555-1234", "4163544"). The contract: an explicit international
// prefix or an unambiguous local pattern yields a canonical E.164;
// everything else keeps the raw display text and gets no WhatsApp link.

describe("normalizePhoneNumber", () => {
  it("returns an empty display for empty input", () => {
    assert.deepStrictEqual(normalizePhoneNumber(""), {
      e164: null,
      display: "",
      digits: null,
    });
    assert.deepStrictEqual(normalizePhoneNumber("   ").display, "");
  });

  it("normalizes an explicit + international number", () => {
    const phone = normalizePhoneNumber("+599 416 3544");
    assert.strictEqual(phone.e164, "+5994163544");
    assert.strictEqual(phone.digits, "5994163544");
    assert.strictEqual(phone.display, "+599 416 3544");
  });

  it("strips common punctuation from international input", () => {
    assert.strictEqual(
      normalizePhoneNumber("+1 (721) 555-1234").e164,
      "+17215551234"
    );
    assert.strictEqual(
      normalizePhoneNumber("+1 721 555 1234").display,
      "+1 721 555 1234"
    );
  });

  it("treats a 00 prefix as an international dial prefix", () => {
    assert.strictEqual(
      normalizePhoneNumber("00599 416 3544").e164,
      "+5994163544"
    );
    assert.strictEqual(
      normalizePhoneNumber("00 1 721 555 1234").e164,
      "+17215551234"
    );
  });

  it("interprets a bare 7-digit number as a Saba local (+599)", () => {
    const phone = normalizePhoneNumber("416 3544");
    assert.strictEqual(phone.e164, "+5994163544");
    assert.strictEqual(
      normalizePhoneNumber("416-3544").e164,
      "+5994163544"
    );
  });

  it("accepts a bare 599-prefixed local number without the +", () => {
    assert.strictEqual(
      normalizePhoneNumber("599 416 3544").e164,
      "+5994163544"
    );
  });

  it("interprets NANP shapes (+1 … Sint Maarten and neighbors)", () => {
    assert.strictEqual(
      normalizePhoneNumber("1 721 555 1234").e164,
      "+17215551234"
    );
    assert.strictEqual(
      normalizePhoneNumber("(721) 555-1234").e164,
      "+17215551234"
    );
    assert.strictEqual(
      normalizePhoneNumber("7215551234").e164,
      "+17215551234"
    );
  });

  it("does not misfile a bare 10-digit number starting with 599 as NANP", () => {
    // 5994163544 is exactly the +599 check above — Caribbean Netherlands,
    // never +1 599 ...
    assert.strictEqual(
      normalizePhoneNumber("5994163544").e164,
      "+5994163544"
    );
  });

  it("keeps ambiguous input as raw display with no E.164", () => {
    for (const raw of [
      "12345", // too short for anything
      "call the office",
      "+0123456", // leading zero after + — not a valid E.164
      "+599 416 3544 ext 9 is long enough".padEnd(60, "1"), // > 15 digits
    ]) {
      const phone = normalizePhoneNumber(raw);
      assert.strictEqual(phone.e164, null, `expected no e164 for ${raw}`);
      assert.strictEqual(phone.display, raw.trim());
    }
  });

  it("never produces an E.164 longer than 15 digits", () => {
    const phone = normalizePhoneNumber("+599416354412345678901");
    assert.strictEqual(phone.e164, null);
  });
});

describe("telHref", () => {
  it("links the canonical E.164 form", () => {
    const phone = normalizePhoneNumber("+599 416 3544");
    assert.strictEqual(telHref(phone), "tel:+5994163544");
  });

  it("returns null for unparseable input — no guessed tel target", () => {
    const phone = normalizePhoneNumber("call the office");
    assert.strictEqual(telHref(phone), null);
  });
});

describe("whatsappHref", () => {
  it("builds a wa.me link only from a confident E.164", () => {
    const phone = normalizePhoneNumber("+599 416 3544");
    assert.strictEqual(whatsappHref(phone), "https://wa.me/5994163544");
  });

  it("returns null for numbers that cannot be confidently normalized", () => {
    // A guessed wa.me URL would target the wrong person's account.
    assert.strictEqual(
      whatsappHref(normalizePhoneNumber("see note")),
      null
    );
    assert.strictEqual(whatsappHref(normalizePhoneNumber("12345")), null);
  });
});
