import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";

// Route-level coverage for POST /api/admin/payments (issue #206): the
// bearer-token gate runs before anything else, an unrecognized payment
// rail is rejected by the parser before the domain layer, and a valid
// cash request reaches createAdminPayment with the rail intact.
// Server-only dependencies are module-mocked; the handler runs against a
// real NextRequest so the auth decisions being tested are the route's own.

mock.module("server-only", { namedExports: {} });

let adminError: { message: string; status: number } | null = null;
const requestedPermissions: string[] = [];

mock.module("@/lib/admin-auth", {
  namedExports: {
    // Routes now authorize by capability (issue #210); the mock records the
    // requested permission so the tests can assert which one the route
    // requires.
    requireAdminPermission: async (_idToken: string, permission: string) => {
      requestedPermissions.push(permission);
      if (adminError) {
        throw Object.assign(new Error(adminError.message), {
          clientSafe: true,
          status: adminError.status,
        });
      }
      return {
        token: { uid: "admin-1", email: "admin@example.test" },
        claims: { admin: true, role: "admin" },
        record: { uid: "admin-1", email: "admin@example.test" },
      };
    },
  },
});

const createCalls: Record<string, unknown>[] = [];

mock.module("@/lib/payments-admin", {
  namedExports: {
    createAdminPayment: async (input: Record<string, unknown>) => {
      createCalls.push(input);
      return {
        id: input.clientRequestId as string,
        data: {
          paymentMethod: input.paymentMethod,
          status: input.paymentMethod === "cash" ? "paid" : "created",
          amountMinor: input.amountMinor,
          customerName: input.customerName,
          description: input.description,
          purpose: input.purpose,
        },
        replayed: false,
      };
    },
    listPayments: async () => [],
    paymentActorOf: () => ({ uid: "admin-1", name: "Sam Admin" }),
  },
});

const VALID_BODY = {
  clientRequestId: "9f8e7d6c-1234-4abc-9def-0123456789ab",
  purpose: "other",
  description: "Walk-in merch",
  amount: "25.00",
  customerName: "Walk-in Customer",
};

function post(body: unknown, authorized = true) {
  return new NextRequest("https://deepdivebrewing.com/api/admin/payments", {
    method: "POST",
    headers: {
      ...(authorized ? { Authorization: "Bearer test-token" } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/payments", () => {
  it("requires the payments capability (not just admin status)", async () => {
    requestedPermissions.length = 0;
    const { POST } = await import("@/app/api/admin/payments/route");
    const res = await POST(post({ ...VALID_BODY, paymentMethod: "cash" }));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(requestedPermissions, ["payments"]);
  });

  it("returns 403 when the payments capability is denied", async () => {
    adminError = {
      message: 'This action requires the "payments" admin permission.',
      status: 403,
    };
    createCalls.length = 0;
    const { POST } = await import("@/app/api/admin/payments/route");
    const res = await POST(post({ ...VALID_BODY, paymentMethod: "cash" }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(createCalls.length, 0);
    adminError = null;
  });

  it("requires a bearer token", async () => {
    const { POST } = await import("@/app/api/admin/payments/route");
    const res = await POST(post({ ...VALID_BODY, paymentMethod: "cash" }, false));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(createCalls.length, 0);
  });

  it("passes an explicit cash rail through to the domain layer", async () => {
    adminError = null;
    createCalls.length = 0;
    const { POST } = await import("@/app/api/admin/payments/route");
    const res = await POST(
      post({ ...VALID_BODY, paymentMethod: "cash" })
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].paymentMethod, "cash");
    const body = (await res.json()) as {
      payment: { paymentMethod: string; status: string };
    };
    assert.strictEqual(body.payment.paymentMethod, "cash");
    assert.strictEqual(body.payment.status, "paid");
  });

  it("defaults an absent rail to card — earlier clients stay compatible", async () => {
    createCalls.length = 0;
    const { POST } = await import("@/app/api/admin/payments/route");
    const res = await POST(post(VALID_BODY));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(createCalls[0].paymentMethod, "card");
  });

  it("rejects an unrecognized rail before the domain layer", async () => {
    createCalls.length = 0;
    const { POST } = await import("@/app/api/admin/payments/route");
    const res = await POST(post({ ...VALID_BODY, paymentMethod: "venmo" }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(createCalls.length, 0);
  });

  it("still requires a valid amount for cash", async () => {
    createCalls.length = 0;
    const { POST } = await import("@/app/api/admin/payments/route");
    for (const amount of ["-5.00", "0", "abc"]) {
      const res = await POST(
        post({ ...VALID_BODY, paymentMethod: "cash", amount })
      );
      assert.strictEqual(res.status, 400, `amount ${amount}`);
    }
    assert.strictEqual(createCalls.length, 0);
  });
});
