import { describe, it } from "node:test";
import assert from "node:assert";
import { isValidEmail } from "@/lib/email";

// The canonical policy is deliberately pragmatic — not RFC 5322. It accepts
// ordinary addresses (plus tags, subdomains, dotted local parts) and rejects
// input that could never reach a mailbox.
describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const email of [
      "customer@example.com",
      "first.last@example.com",
      "customer+trade@example.com",
      "sales@subdomain.example.com",
      "sales@wholesale.example.com",
    ]) {
      assert.ok(isValidEmail(email), `expected valid: ${email}`);
    }
  });

  it("rejects malformed addresses", () => {
    for (const email of [
      "not-an-email",
      "customer@",
      "@example.com",
      "customer@example",
      "customer @example.com",
      "customer@exam ple.com",
      "customer@@example.com",
      "customer@example@com",
      "",
      "   ",
    ]) {
      assert.ok(!isValidEmail(email), `expected invalid: ${email}`);
    }
  });

  // Callers normalize (trim) before validating — the check itself treats
  // surrounding whitespace as part of the candidate and rejects it.
  it("rejects surrounding whitespace rather than repairing it", () => {
    assert.ok(!isValidEmail(" customer@example.com"));
    assert.ok(!isValidEmail("customer@example.com "));
  });
});
