import { describe, it } from "node:test";
import assert from "node:assert";
import { Timestamp } from "firebase-admin/firestore";
import {
  decryptQboSecret,
  encryptQboSecret,
  parseQboEncryptionKey,
} from "@/lib/qbo-crypto";
import { installQboDbMock, withEnv } from "./qbo-test-helpers";

const firestore = installQboDbMock();
const CONNECTION = "qboConnections/sandbox";
const ENV = {
  QBO_ENVIRONMENT: "sandbox",
  QBO_CLIENT_ID: "client-id",
  QBO_CLIENT_SECRET: "client-secret",
  QBO_REDIRECT_URI: "https://app.example.com/api/admin/quickbooks/callback",
  // A zeroed AES-256 test key — never a real secret.
  QBO_TOKEN_ENCRYPTION_KEY: "0".repeat(64),
};

const key = () => parseQboEncryptionKey(ENV.QBO_TOKEN_ENCRYPTION_KEY);
const enc = (value: string) => encryptQboSecret(value, key());
const dec = (value: unknown) => decryptQboSecret(String(value), key());

function doc() {
  const data = firestore.docs.get(CONNECTION);
  assert.ok(data, "connection doc missing");
  return data;
}

function seedConnected() {
  firestore.reset({
    [CONNECTION]: {
      environment: "sandbox",
      status: "connected",
      realmId: "realm-1",
      accessTokenEnc: enc("at-0"),
      refreshTokenEnc: enc("rt-0"),
      // Expired access token → the acquire step takes the refresh path.
      accessTokenExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    },
  });
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      x_refresh_token_expires_in: 8_640_000,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// Drives the Intuit round-trip. `midFlight` mutates the stored record to
// simulate an admin action or a second caller landing while the provider
// request is outstanding.
function stubFetch(midFlight?: () => void, respond = tokenResponse) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    midFlight?.();
    return Promise.resolve(respond());
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function getAccessToken() {
  const { getQuickBooksAccessToken } = await import("@/lib/qbo-tokens");
  return withEnv(ENV, () => getQuickBooksAccessToken());
}

describe("getQuickBooksAccessToken", () => {
  it("commits rotated tokens when the record is unchanged mid-refresh", async () => {
    seedConnected();
    const restore = stubFetch();
    try {
      const result = await getAccessToken();
      assert.strictEqual(result.accessToken, "at-1");
      assert.strictEqual(result.realmId, "realm-1");
      assert.strictEqual(dec(doc().accessTokenEnc), "at-1");
      assert.strictEqual(dec(doc().refreshTokenEnc), "rt-1");
      assert.strictEqual(doc().status, "connected");
      assert.strictEqual(doc().refreshLeaseUntil, undefined);
    } finally {
      restore();
    }
  });

  it("cannot revive a connection disconnected while the refresh was in flight", async () => {
    seedConnected();
    // Mirrors disconnectQbo: tokens and the lease are destroyed.
    const restore = stubFetch(() => {
      const data = doc();
      data.status = "disconnected";
      delete data.accessTokenEnc;
      delete data.refreshTokenEnc;
      delete data.refreshLeaseUntil;
    });
    try {
      await assert.rejects(getAccessToken(), /changed during token refresh/);
      const data = doc();
      assert.strictEqual(data.status, "disconnected");
      assert.strictEqual(data.accessTokenEnc, undefined);
      assert.strictEqual(data.refreshTokenEnc, undefined);
    } finally {
      restore();
    }
  });

  it("cannot overwrite a reconnect to a different realm mid-refresh", async () => {
    seedConnected();
    const restore = stubFetch(() => {
      const data = doc();
      data.realmId = "realm-2";
      data.refreshTokenEnc = enc("rt-new");
      delete data.refreshLeaseUntil;
    });
    try {
      await assert.rejects(getAccessToken(), /changed during token refresh/);
      const data = doc();
      assert.strictEqual(data.realmId, "realm-2");
      assert.strictEqual(dec(data.refreshTokenEnc), "rt-new");
    } finally {
      restore();
    }
  });

  it("cannot commit while a successor holds a different lease", async () => {
    seedConnected();
    // Another caller re-acquired the refresh lease after ours expired.
    const successorLease = Timestamp.fromMillis(Date.now() + 90_000);
    const restore = stubFetch(() => {
      doc().refreshLeaseUntil = successorLease;
    });
    try {
      await assert.rejects(getAccessToken(), /changed during token refresh/);
      const data = doc();
      // The stale refresh's rotated tokens were dropped — the stored
      // grant and the successor's lease are untouched.
      assert.strictEqual(dec(data.refreshTokenEnc), "rt-0");
      assert.strictEqual(
        (data.refreshLeaseUntil as Timestamp).toMillis(),
        successorLease.toMillis()
      );
    } finally {
      restore();
    }
  });

  it("leaves a successor's lease alone when the provider refresh fails", async () => {
    seedConnected();
    const successorLease = Timestamp.fromMillis(Date.now() + 90_000);
    const restore = stubFetch(
      () => {
        doc().refreshLeaseUntil = successorLease;
      },
      () => new Response("upstream error", { status: 502 })
    );
    try {
      await assert.rejects(getAccessToken());
      const data = doc();
      assert.strictEqual(data.status, "connected");
      assert.strictEqual(
        (data.refreshLeaseUntil as Timestamp).toMillis(),
        successorLease.toMillis()
      );
    } finally {
      restore();
    }
  });

  it("marks the record reauthorization_required when Intuit revokes the grant", async () => {
    seedConnected();
    const restore = stubFetch(
      undefined,
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
    );
    try {
      await assert.rejects(getAccessToken(), /no longer valid/);
      const data = doc();
      assert.strictEqual(data.status, "reauthorization_required");
      assert.strictEqual(data.refreshLeaseUntil, undefined);
      // The revoked grant stays on record — nothing else was overwritten.
      assert.strictEqual(dec(data.refreshTokenEnc), "rt-0");
    } finally {
      restore();
    }
  });
});

describe("requestQboTokens intuit_tid", () => {
  // The token endpoint returns `intuit_tid` on success and failure alike;
  // both must reach the caller so refreshes and errors carry the provider
  // correlation id into server-side logs.
  const REQUEST = {
    url: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token",
  };

  it("returns the transaction id on a successful token call", async () => {
    const restore = stubFetch(undefined, () => {
      const res = tokenResponse();
      res.headers.set("intuit_tid", "tid-ok");
      return res;
    });
    try {
      const { requestQboTokens } = await import("@/lib/qbo-tokens");
      const { tokens, correlationId } = await requestQboTokens(
        REQUEST,
        "token refresh"
      );
      assert.strictEqual(tokens.accessToken, "at-1");
      assert.strictEqual(correlationId, "tid-ok");
    } finally {
      restore();
    }
  });

  it("keeps the transaction id on a failed token call", async () => {
    const restore = stubFetch(
      undefined,
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: {
            "content-type": "application/json",
            intuit_tid: "tid-fail",
          },
        })
    );
    try {
      const { requestQboTokens } = await import("@/lib/qbo-tokens");
      await assert.rejects(
        requestQboTokens(REQUEST, "token refresh"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.strictEqual(
            (error as { correlationId?: string }).correlationId,
            "tid-fail"
          );
          return true;
        }
      );
    } finally {
      restore();
    }
  });
});
