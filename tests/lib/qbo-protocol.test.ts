import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildQboAuthorizationUrl,
  buildQboQueryUrl,
  buildQboRevokeRequest,
  buildQboTokenExchangeRequest,
  buildQboTokenRefreshRequest,
  canonicalizeCompanyInfo,
  canonicalizeQboPayments,
  canonicalizeQboQueryEntities,
  canonicalizeQboUndepositedFundsAccount,
  qboPaymentsQuery,
  qboUndepositedFundsQuery,
  classifyQboOAuthState,
  decideQboTokenAction,
  generateQboOAuthState,
  parseQboTokenResponse,
  qboEntityQueryStatement,
  qboErrorForHttpStatus,
  qboQueryRowCount,
  qboTokenResponseIsInvalidGrant,
  toQboError,
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

describe("canonicalizeCompanyInfo", () => {
  it("extracts the safe company metadata", () => {
    const info = canonicalizeCompanyInfo({
      CompanyInfo: {
        // Real sandbox responses carry an entity Id unrelated to the OAuth
        // realmId — it is provider metadata, never the connection realm.
        Id: "1",
        CompanyName: "Deep Dive Brewing Sandbox",
        Country: "US",
        Email: { Address: "internal@example.com" },
      },
    });
    assert.deepStrictEqual(info, {
      companyName: "Deep Dive Brewing Sandbox",
      country: "US",
    });
    // Provider fields — including Id — never leak into the canonical shape.
    assert.ok(!("realmId" in info));
    assert.ok(!("Id" in info));
  });

  it("accepts a valid payload whatever the Id value, or none at all", () => {
    for (const payload of [
      { CompanyInfo: { Id: "1", CompanyName: "Co" } },
      { CompanyInfo: { Id: "9341454755", CompanyName: "Co" } },
      { CompanyInfo: { CompanyName: "Co" } },
    ]) {
      assert.deepStrictEqual(canonicalizeCompanyInfo(payload), {
        companyName: "Co",
        country: undefined,
      });
    }
  });

  it("rejects malformed and missing CompanyInfo payloads", () => {
    const badPayloads: unknown[] = [
      null,
      {},
      "x",
      { CompanyInfo: null },
      { CompanyInfo: {} },
      { CompanyInfo: { Id: "1" } },
      { CompanyInfo: { CompanyName: "" } },
      { CompanyInfo: { CompanyName: 42 } },
    ];
    for (const payload of badPayloads) {
      try {
        canonicalizeCompanyInfo(payload);
        assert.fail(`expected rejection for ${JSON.stringify(payload)}`);
      } catch (error) {
        assert.ok(error instanceof QboError);
        assert.strictEqual(error.kind, "unexpected");
        assert.strictEqual(error.clientSafe, true);
      }
    }
  });

  it("does not echo provider data in the rejection", () => {
    try {
      canonicalizeCompanyInfo({
        CompanyInfo: { Id: "secret-realm", Notes: "leak" },
      });
      assert.fail("expected rejection");
    } catch (error) {
      assert.ok(error instanceof QboError);
      assert.ok(!error.message.includes("secret-realm"));
      assert.ok(!error.message.includes("leak"));
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

describe("qboPaymentsQuery / canonicalizeQboPayments", () => {
  it("builds a date-windowed Payment select with pagination", () => {
    const query = qboPaymentsQuery("2026-10-01", "2026-10-31", 1, 1000);
    assert.ok(query.includes("from Payment"));
    assert.ok(query.includes("TxnDate >= '2026-10-01'"));
    assert.ok(query.includes("TxnDate <= '2026-10-31'"));
    assert.ok(query.includes("DepositToAccountRef"));
    assert.ok(query.includes("PaymentRefNum"));
  });

  it("canonicalizes Ollie-shaped payments: reference, memo, links, UF target", () => {
    const rows = canonicalizeQboPayments({
      QueryResponse: {
        Payment: [
          {
            Id: "42",
            TxnDate: "2026-10-08",
            TotalAmt: 294.01,
            CurrencyRef: { value: "USD" },
            CustomerRef: { value: "7", name: "Sea Saba" },
            PaymentRefNum: "Ollie Payment #1626166",
            PrivateNote: "applied to invoice #00327",
            DepositToAccountRef: { value: "uf-9" },
            Line: [{ LinkedTxn: [{ TxnId: "inv-327" }] }],
          },
          {
            Id: "43",
            TotalAmt: 50,
            // No TxnDate, no DepositToAccountRef, no CurrencyRef —
            // UF default target + unverified currency/date.
            Line: [],
          },
        ],
      },
    });
    assert.strictEqual(rows.length, 2);
    const first = rows[0];
    assert.strictEqual(first.id, "42");
    assert.strictEqual(first.totalMinor, 29401);
    assert.strictEqual(first.currency, "USD");
    assert.strictEqual(first.depositToAccountId, "uf-9");
    assert.strictEqual(first.customerName, "Sea Saba");
    assert.strictEqual(first.refNumber, "Ollie Payment #1626166");
    assert.strictEqual(first.memo, "applied to invoice #00327");
    assert.deepStrictEqual(first.linkedTxnIds, ["inv-327"]);
    const second = rows[1];
    assert.strictEqual(second.totalMinor, 5000);
    assert.strictEqual(second.depositToAccountId, undefined);
    assert.strictEqual(second.currency, undefined);
    assert.strictEqual(second.txnDate, undefined);
  });

  it("drops rows with no id or amount and tolerates empty responses", () => {
    assert.deepStrictEqual(
      canonicalizeQboPayments({ QueryResponse: { Payment: [{ Id: "1" }] } }),
      []
    );
    assert.deepStrictEqual(canonicalizeQboPayments(null), []);
    assert.deepStrictEqual(canonicalizeQboPayments({ QueryResponse: {} }), []);
  });
});

describe("qboUndepositedFundsQuery / canonicalizeQboUndepositedFundsAccount", () => {
  it("queries by the UndepositedFunds subtype", () => {
    assert.ok(
      qboUndepositedFundsQuery().includes("AccountSubType = 'UndepositedFunds'")
    );
  });

  it("resolves the single UF account and fails closed otherwise", () => {
    assert.deepStrictEqual(
      canonicalizeQboUndepositedFundsAccount({
        QueryResponse: {
          Account: [{ Id: "uf-1", Name: "Undeposited Funds" }],
        },
      }),
      { id: "uf-1", name: "Undeposited Funds" }
    );
    // Zero or several UF-typed accounts — never guess which one.
    assert.strictEqual(
      canonicalizeQboUndepositedFundsAccount({ QueryResponse: { Account: [] } }),
      null
    );
    assert.strictEqual(
      canonicalizeQboUndepositedFundsAccount({
        QueryResponse: { Account: [{ Id: "a" }, { Id: "b" }] },
      }),
      null
    );
    assert.strictEqual(canonicalizeQboUndepositedFundsAccount(null), null);
  });
});
