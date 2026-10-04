// AdminAuthGate is a client component requiring Firebase Auth, so its copy
// contract is asserted on the source — the same pattern as the trade-inquiry
// route wiring tests in tests/lib/trade-leads.test.ts. Regression guard for
// the shared sign-in prompt: the gate renders a caller-supplied description
// so each admin surface names what it manages instead of one hard-coded
// surface leaking onto the others.
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

describe("AdminAuthGate sign-in copy", () => {
  const gate = read("components/admin-auth-gate.tsx");

  it("renders a caller-supplied description, not a hard-coded surface", () => {
    assert.ok(gate.includes("{description}"));
    assert.ok(!gate.includes("manage trade leads"));
    assert.ok(!gate.includes("QuickBooks integration"));
  });

  it("gives each admin surface its own prompt", () => {
    const cases: Array<[string, string]> = [
      [
        "components/admin-trade-page.tsx",
        "manage trade leads.",
      ],
      [
        "components/admin-payments-page.tsx",
        "manage payments.",
      ],
      [
        "components/admin-quickbooks-page.tsx",
        "manage the QuickBooks integration.",
      ],
    ];
    for (const [path, prompt] of cases) {
      const source = read(path);
      assert.ok(
        source.includes(`description="Sign in with an authorized Google account to ${prompt}"`),
        `${path} must pass its own sign-in description`
      );
    }
  });
});
