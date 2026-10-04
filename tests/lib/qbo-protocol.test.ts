import { describe, it } from "node:test";
import assert from "node:assert";
import { createHmac } from "node:crypto";
import {
  buildQboAuthorizationUrl,
  buildQboQueryUrl,
  buildQboRevokeRequest,
  buildQboTokenExchangeRequest,
  buildQboTokenRefreshRequest,
  canonicalizeCompanyInfo,
  canonicalizeQboQueryEntities,
  classifyQboOAuthState,
  decideQboTokenAction,
  generateQboOAuthState,
  parseQboTokenResponse,
  parseQboWebhookNotifications,
  qboEntityQueryStatement,
  qboErrorForHttpStatus,
  qboQueryRowCount,
  qboTokenResponseIsInvalidGrant,
  qboWebhookDedupeKey,
  toQboError,
  verifyQboWebhookSignature,
  QBO_ACCESS_TOKEN_SKEW_MS,
} from "@/lib/qbo-protocol";
import { QboError } from "@/lib/qbo-errors";

describe("generateQboOAuthState", () => {
  it("produces strong, unique, url-safe states", () => {
    const a = generateQboOAuthState();
    const b = generateQboOAuthState();
    assert.notStrictEqual(a, b);
    assert.ok(a.length >= 40);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });
});

describe("classifyQboOAuthState", () => {
  const now = 1_000_000;
  it("accepts an unconsumed, unexpired state", () => {
    assert.strictEqual(
      classifyQboOAuthState({ expiresAtMs: now + 1 }, now),
      "ok"
    );
  });
  it("rejects expired and consumed states", () => {
    assert.strictEqual(
      classifyQboOAuthState({ expiresAtMs: now }, now),
      "expired"
    );
    assert.strictEqual(
      classifyQboOAuthState(
        { expiresAtMs: now + 1000, consumedAtMs: now - 1 },
        now
      ),
      "consumed"
    );
  });
});

describe("buildQboAuthorizationUrl", () => {
  it("targets Intuit with the accounting scope and the given state", () => {
    const url = new URL(
      buildQboAuthorizationUrl({
        clientId: "cid",
        redirectUri: "https://app.example.com/cb",
        state: "state-123",
      })
    );
    assert.strictEqual(url.origin, "https://appcenter.intuit.com");
    assert.strictEqual(url.pathname, "/connect/oauth2");
    assert.strictEqual(
      url.searchParams.get("scope"),
      "com.intuit.quickbooks.accounting"
    );
    assert.strictEqual(url.searchParams.get("response_type"), "code");
    assert.strictEqual(url.searchParams.get("state"), "state-123");
    assert.strictEqual(
      url.searchParams.get("redirect_uri"),
      "https://app.example.com/cb"
    );
    assert.strictEqual(url.searchParams.get("client_id"), "cid");
  });
});

describe("token endpoint requests", () => {
  it("builds an authorization_code exchange with Basic auth", () => {
    const req = buildQboTokenExchangeRequest({
      clientId: "cid",
      clientSecret: "sec",
      code: "authcode",
      redirectUri: "https://app.example.com/cb",
    });
    assert.strictEqual(
      req.url,
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
    );
    assert.strictEqual(
      req.headers.Authorization,
      `Basic ${Buffer.from("cid:sec").toString("base64")}`
    );
    const body = new URLSearchParams(req.body);
    assert.strictEqual(body.get("grant_type"), "authorization_code");
    assert.strictEqual(body.get("code"), "authcode");
    assert.strictEqual(body.get("redirect_uri"), "https://app.example.com/cb");
  });

  it("builds a refresh_token request", () => {
    const req = buildQboTokenRefreshRequest({
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "rt",
    });
    const body = new URLSearchParams(req.body);
    assert.strictEqual(body.get("grant_type"), "refresh_token");
    assert.strictEqual(body.get("refresh_token"), "rt");
  });

  it("builds a JSON revoke request carrying the refresh token", () => {
    const req = buildQboRevokeRequest({
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "rt",
    });
    assert.strictEqual(
      req.url,
      "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"
    );
    assert.deepStrictEqual(JSON.parse(req.body), { token: "rt" });
  });
});

describe("parseQboTokenResponse", () => {
  it("parses a full Intuit token response", () => {
    const tokens = parseQboTokenResponse({
      token_type: "bearer",
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      x_refresh_token_expires_in: 8726400,
    });
    assert.deepStrictEqual(tokens, {
      accessToken: "at",
      refreshToken: "rt",
      accessTokenExpiresInSec: 3600,
      refreshTokenExpiresInSec: 8726400,
    });
  });

  it("tolerates a missing refresh-token expiry", () => {
    const tokens = parseQboTokenResponse({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
    });
    assert.strictEqual(tokens.refreshTokenExpiresInSec, undefined);
  });

  it("rejects malformed responses", () => {
    for (const bad of [
      null,
      "x",
      {},
      { access_token: "at", expires_in: 3600 },
      { access_token: "", refresh_token: "rt", expires_in: 3600 },
      { access_token: "at", refresh_token: "rt", expires_in: 0 },
    ]) {
      assert.throws(() => parseQboTokenResponse(bad), QboError);
    }
  });
});

describe("qboTokenResponseIsInvalidGrant", () => {
  it("detects invalid_grant bodies only", () => {
    assert.strictEqual(
      qboTokenResponseIsInvalidGrant({ error: "invalid_grant" }),
      true
    );
    assert.strictEqual(
      qboTokenResponseIsInvalidGrant({ error: "temporarily_unavailable" }),
      false
    );
    assert.strictEqual(qboTokenResponseIsInvalidGrant(null), false);
  });
});

describe("decideQboTokenAction", () => {
  const now = 1_000_000;
  it("uses a live access token", () => {
    assert.strictEqual(
      decideQboTokenAction(
        { accessTokenExpiresAtMs: now + QBO_ACCESS_TOKEN_SKEW_MS + 1000 },
        now
      ),
      "use"
    );
  });
  it("refreshes when the token is inside the safety skew", () => {
    assert.strictEqual(
      decideQboTokenAction(
        { accessTokenExpiresAtMs: now + QBO_ACCESS_TOKEN_SKEW_MS - 1 },
        now
      ),
      "refresh"
    );
  });
  it("waits while another caller holds the refresh lease", () => {
    assert.strictEqual(
      decideQboTokenAction(
        {
          accessTokenExpiresAtMs: now - 1000,
          refreshLeaseUntilMs: now + 5000,
        },
        now
      ),
      "wait"
    );
  });
  it("refreshes once the lease has expired", () => {
    assert.strictEqual(
      decideQboTokenAction(
        {
          accessTokenExpiresAtMs: now - 1000,
          refreshLeaseUntilMs: now - 1,
        },
        now
      ),
      "refresh"
    );
  });
});

describe("qboErrorForHttpStatus", () => {
  it("maps statuses to the internal taxonomy", () => {
    const cases: Array<[number, string]> = [
      [401, "authorization_expired"],
      [403, "permission_denied"],
      [429, "rate_limited"],
      [400, "validation"],
      [422, "validation"],
      [500, "unavailable"],
      [503, "unavailable"],
      [418, "unexpected"],
    ];
    for (const [status, kind] of cases) {
      const err = qboErrorForHttpStatus(status);
      assert.strictEqual(err.kind, kind, `status ${status}`);
      assert.ok(err instanceof QboError);
      assert.strictEqual(err.clientSafe, true);
    }
  });

  it("treats invalid_grant as authorization_expired regardless of status", () => {
    const err = qboErrorForHttpStatus(400, { invalidGrant: true });
    assert.strictEqual(err.kind, "authorization_expired");
  });

  it("retains the Intuit correlation id without leaking bodies", () => {
    const err = qboErrorForHttpStatus(500, { correlationId: "tid-123" });
    assert.strictEqual(err.correlationId, "tid-123");
    assert.ok(!err.message.includes("{"));
  });
});

describe("toQboError", () => {
  it("passes QboError through and wraps unknowns as unavailable", () => {
    const original = new QboError("x", "rate_limited");
    assert.strictEqual(toQboError(original, "op"), original);
    const wrapped = toQboError(new Error("boom"), "op");
    assert.strictEqual(wrapped.kind, "unavailable");
    assert.ok(!wrapped.message.includes("boom"));
  });
});

describe("buildQboQueryUrl", () => {
  it("encodes the query and pins the minor version", () => {
    const url = new URL(
      buildQboQueryUrl("sandbox", "realm-1", "select * from Account")
    );
    assert.strictEqual(
      url.origin,
      "https://sandbox-quickbooks.api.intuit.com"
    );
    assert.strictEqual(
      url.pathname,
      "/v3/company/realm-1/query"
    );
    assert.strictEqual(url.searchParams.get("minorversion"), "75");
    assert.strictEqual(
      url.searchParams.get("query"),
      "select * from Account"
    );
  });

  it("never allows a non-Intuit host", () => {
    const url = buildQboQueryUrl("production", "realm-1", "select 1");
    assert.ok(url.startsWith("https://quickbooks.api.intuit.com/"));
  });
});

describe("verifyQboWebhookSignature", () => {
  const verifier = "verifier-token";
  const body = JSON.stringify({ eventNotifications: [] });

  function sign(payload: string): string {
    return createHmac("sha256", verifier).update(payload, "utf8").digest("base64");
  }

  it("accepts a valid signature over the raw body", () => {
    assert.strictEqual(
      verifyQboWebhookSignature(body, sign(body), verifier),
      true
    );
  });

  it("rejects invalid, missing, and malformed signatures", () => {
    assert.strictEqual(
      verifyQboWebhookSignature(body, sign("other"), verifier),
      false
    );
    assert.strictEqual(verifyQboWebhookSignature(body, null, verifier), false);
    assert.strictEqual(verifyQboWebhookSignature(body, "", verifier), false);
    assert.strictEqual(
      verifyQboWebhookSignature(body, "not-base64!!", verifier),
      false
    );
    assert.strictEqual(
      verifyQboWebhookSignature(body, sign(body), "wrong-verifier"),
      false
    );
  });

  it("rejects a signature computed over a transformed body", () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    assert.strictEqual(
      verifyQboWebhookSignature(pretty, sign(body), verifier),
      false
    );
  });
});

describe("parseQboWebhookNotifications", () => {
  it("parses batched notifications and entities", () => {
    const payload = JSON.stringify({
      eventNotifications: [
        {
          realmId: "r1",
          dataChangeEvent: {
            entities: [
              {
                name: "Customer",
                id: "42",
                operation: "Create",
                lastUpdated: "2026-01-01T00:00:00Z",
              },
              {
                name: "Invoice",
                id: 7,
                operation: "Update",
                lastUpdated: "2026-01-01T00:01:00Z",
              },
            ],
          },
        },
        {
          realmId: "r2",
          dataChangeEvent: {
            entities: [
              {
                name: "Item",
                id: "3",
                operation: "Delete",
                lastUpdated: "2026-01-01T00:02:00Z",
              },
            ],
          },
        },
      ],
    });
    const notifications = parseQboWebhookNotifications(payload);
    assert.strictEqual(notifications.length, 3);
    assert.deepStrictEqual(notifications[0], {
      realmId: "r1",
      entityName: "Customer",
      entityId: "42",
      operation: "Create",
      lastUpdated: "2026-01-01T00:00:00Z",
    });
    assert.strictEqual(notifications[1].entityId, "7");
    assert.strictEqual(notifications[2].realmId, "r2");
  });

  it("drops malformed payloads and entities defensively", () => {
    assert.deepStrictEqual(parseQboWebhookNotifications("not json"), []);
    assert.deepStrictEqual(parseQboWebhookNotifications("{}"), []);
    assert.deepStrictEqual(
      parseQboWebhookNotifications('{"eventNotifications":"x"}'),
      []
    );
    const partial = JSON.stringify({
      eventNotifications: [
        { realmId: "", dataChangeEvent: { entities: [{ name: "X", id: "1" }] } },
        { realmId: "r", dataChangeEvent: { entities: [{ id: "1" }] } },
        { realmId: "r", dataChangeEvent: { entities: [{ name: "X" }] } },
        { realmId: "r", dataChangeEvent: { entities: [{ name: "X", id: "9" }] } },
      ],
    });
    const notifications = parseQboWebhookNotifications(partial);
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].entityId, "9");
  });
});

describe("qboWebhookDedupeKey", () => {
  it("is stable for identical notifications and differs otherwise", () => {
    const base = {
      realmId: "r",
      entityName: "Customer",
      entityId: "1",
      operation: "Create",
      lastUpdated: "t",
    };
    assert.strictEqual(qboWebhookDedupeKey(base), qboWebhookDedupeKey({ ...base }));
    assert.notStrictEqual(
      qboWebhookDedupeKey(base),
      qboWebhookDedupeKey({ ...base, operation: "Update" })
    );
    assert.match(qboWebhookDedupeKey(base), /^[0-9a-f]{64}$/);
  });
});

describe("canonicalizeCompanyInfo", () => {
  it("extracts the safe company identity when the realm matches", () => {
    const info = canonicalizeCompanyInfo(
      {
        CompanyInfo: {
          Id: "934145475",
          CompanyName: "Deep Dive Brewing Sandbox",
          Country: "US",
          Email: { Address: "internal@example.com" },
        },
      },
      "934145475"
    );
    assert.deepStrictEqual(info, {
      realmId: "934145475",
      companyName: "Deep Dive Brewing Sandbox",
      country: "US",
    });
  });

  it("rejects missing, empty, non-string, and mismatched company ids", () => {
    const badPayloads: unknown[] = [
      null,
      {},
      { CompanyInfo: null },
      { CompanyInfo: {} },
      { CompanyInfo: { Id: "" } },
      { CompanyInfo: { Id: 934145475 } },
      { CompanyInfo: { Id: "other-realm", CompanyName: "Wrong Co" } },
    ];
    for (const payload of badPayloads) {
      try {
        canonicalizeCompanyInfo(payload, "realm-1");
        assert.fail(`expected rejection for ${JSON.stringify(payload)}`);
      } catch (error) {
        assert.ok(error instanceof QboError);
        assert.strictEqual(error.kind, "unexpected");
        assert.strictEqual(error.clientSafe, true);
      }
    }
  });

  it("never substitutes the requested realm for a missing or foreign id", () => {
    // A provider answer for another company must not be absorbed into the
    // requested realm — and the rejection must not echo provider data.
    for (const payload of [
      {},
      { CompanyInfo: { Id: "other-realm", CompanyName: "Wrong Co" } },
    ]) {
      try {
        canonicalizeCompanyInfo(payload, "realm-1");
        assert.fail("expected rejection");
      } catch (error) {
        assert.ok(error instanceof QboError);
        assert.ok(!error.message.includes("other-realm"));
        assert.ok(!error.message.includes("Wrong Co"));
      }
    }
  });
});

describe("canonicalizeQboQueryEntities", () => {
  it("reduces accounts to safe summaries", () => {
    const rows = canonicalizeQboQueryEntities("account", {
      QueryResponse: {
        Account: [
          { Id: "1", Name: "Stripe Clearing", AccountType: "Bank", AccountSubType: "Checking", Active: true, SecretField: "x" },
          { Id: "2", Name: "Old", AccountType: "Income", Active: false },
          { Name: "no id" },
        ],
      },
    });
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0], {
      id: "1",
      name: "Stripe Clearing",
      type: "Bank",
      detail: "Checking",
      active: true,
    });
    assert.strictEqual(rows[1].active, false);
    assert.ok(!("SecretField" in rows[0]));
  });

  it("handles customers and empty responses", () => {
    const rows = canonicalizeQboQueryEntities("customer", {
      QueryResponse: {
        Customer: [{ Id: "9", DisplayName: "Walk-in Customer" }],
      },
    });
    assert.deepStrictEqual(rows, [
      { id: "9", name: "Walk-in Customer", type: undefined, detail: undefined, active: true },
    ]);
    assert.deepStrictEqual(canonicalizeQboQueryEntities("item", {}), []);
    assert.deepStrictEqual(canonicalizeQboQueryEntities("item", null), []);
  });
});

describe("qboEntityQueryStatement", () => {
  it("maps every discovery type to a select query", () => {
    const expected: Record<string, string> = {
      account: "select * from Account",
      item: "select * from Item",
      customer: "select * from Customer",
      "payment-method": "select * from PaymentMethod",
      "tax-code": "select * from TaxCode",
    };
    for (const [type, statement] of Object.entries(expected)) {
      assert.strictEqual(
        qboEntityQueryStatement(type as never),
        statement
      );
    }
  });

  it("appends pagination bounds when requested", () => {
    assert.strictEqual(
      qboEntityQueryStatement("customer", 1001, 1000),
      "select * from Customer startposition 1001 maxresults 1000"
    );
    assert.strictEqual(
      qboEntityQueryStatement("account", 1),
      "select * from Account startposition 1 maxresults 1000"
    );
  });
});

describe("qboQueryRowCount", () => {
  it("counts raw rows per entity type for pagination", () => {
    assert.strictEqual(
      qboQueryRowCount("item", {
        QueryResponse: { Item: [{ Id: "1" }, { Id: "2" }] },
      }),
      2
    );
    assert.strictEqual(qboQueryRowCount("item", { QueryResponse: {} }), 0);
    assert.strictEqual(qboQueryRowCount("item", null), 0);
    // The count is of the raw page, not the canonicalized rows.
    assert.strictEqual(
      qboQueryRowCount("account", {
        QueryResponse: { Account: [{ noId: true }] },
      }),
      1
    );
  });
});
