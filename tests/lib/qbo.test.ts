// Unit tests for the QBO connection orchestration in lib/qbo.ts. The
// OAuth callback's realmId is the authoritative connected-company
// identity: completeQboAuthorization must persist exactly that value even
// when the CompanyInfo probe reports a different entity Id (which real
// sandbox responses do). The fake Firestore and a URL-keyed fetch stub
// stand in for Firestore and Intuit.
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  decryptQboSecret,
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

// The realm Intuit delivered on the OAuth callback — the value that must
// end up on the connection record.
const CALLBACK_REALM = "9341454755";

function doc() {
  return firestore.docs.get(CONNECTION);
}

// Drives the two Intuit calls inside completeQboAuthorization: the token
// exchange and the scoped CompanyInfo read.
function stubIntuit(companyInfo: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2/v1/tokens/bearer")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }
    if (url.includes("/companyinfo/")) {
      return Promise.resolve(
        new Response(JSON.stringify(companyInfo), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function complete(realmId = CALLBACK_REALM) {
  const { completeQboAuthorization } = await import("@/lib/qbo");
  return withEnv(ENV, () =>
    completeQboAuthorization({
      code: "authcode-1",
      realmId,
      uid: "uid-1",
      email: "admin@example.com",
    })
  );
}

const dec = (value: unknown) =>
  decryptQboSecret(String(value), parseQboEncryptionKey(ENV.QBO_TOKEN_ENCRYPTION_KEY));

describe("completeQboAuthorization", () => {
  it("persists the OAuth callback realmId, not the CompanyInfo Id", async () => {
    firestore.reset();
    const restore = stubIntuit({
      CompanyInfo: {
        // Sandbox CompanyInfo reports an entity Id unrelated to the realm.
        Id: "1",
        CompanyName: "Sandbox Company_US_a784",
        Country: "US",
        Email: { Address: "internal@example.com" },
      },
    });
    try {
      const result = await complete();
      assert.strictEqual(result.companyName, "Sandbox Company_US_a784");
      const data = doc();
      assert.ok(data, "connection doc missing");
      assert.strictEqual(data.realmId, CALLBACK_REALM);
      assert.strictEqual(data.companyName, "Sandbox Company_US_a784");
      assert.strictEqual(data.companyCountry, "US");
      assert.strictEqual(data.status, "connected");
      assert.strictEqual(data.environment, "sandbox");
      // Tokens are persisted encrypted only.
      assert.strictEqual(dec(data.accessTokenEnc), "at-1");
      assert.strictEqual(dec(data.refreshTokenEnc), "rt-1");
    } finally {
      restore();
    }
  });

  it("stores the same realm when CompanyInfo.Id happens to match", async () => {
    firestore.reset();
    const restore = stubIntuit({
      CompanyInfo: {
        Id: CALLBACK_REALM,
        CompanyName: "Matching Realm Co",
      },
    });
    try {
      await complete();
      const data = doc();
      assert.strictEqual(data?.realmId, CALLBACK_REALM);
      assert.strictEqual(data?.companyName, "Matching Realm Co");
    } finally {
      restore();
    }
  });

  it("does not let CompanyInfo metadata re-assign the realm for a different callback realmId", async () => {
    firestore.reset();
    const restore = stubIntuit({
      CompanyInfo: { Id: "1", CompanyName: "Other Co" },
    });
    try {
      await complete("realm-xyz");
      assert.strictEqual(doc()?.realmId, "realm-xyz");
    } finally {
      restore();
    }
  });

  it("persists nothing when the CompanyInfo payload is malformed", async () => {
    firestore.reset();
    const restore = stubIntuit({ CompanyInfo: { Id: "1" } });
    try {
      await assert.rejects(complete(), /malformed company response/);
      assert.strictEqual(doc(), undefined);
    } finally {
      restore();
    }
  });
});
