import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { QboError } from "@/lib/qbo-errors";
import { installQboDbMock, withEnv } from "./qbo-test-helpers";
import type { AdminActor } from "@/lib/admin-auth";
import type { QboEntitySummary } from "@/lib/qbo-common";

// Unit tests for the accounting-mapping store (lib/qbo-mapping.ts,
// issue #182). The mapping is the gate for the Sales-Receipt posting
// model: it must be bound to the live environment + realm, complete on
// every required field, and resolvable against live provider entities.

const firestore = installQboDbMock();

const state = {
  entities: {} as Record<string, QboEntitySummary[]>,
  tokenError: null as unknown,
};

mock.module("@/lib/qbo-tokens", {
  namedExports: {
    getQuickBooksAccessToken: async () => {
      if (state.tokenError) throw state.tokenError;
      return { accessToken: "at", realmId: "realm-1" };
    },
  },
});

mock.module("@/lib/qbo-api", {
  namedExports: {
    queryQboEntities: async ({ type }: { type: string }) =>
      state.entities[type] ?? [],
  },
});

mock.module("@/lib/admin-audit", {
  namedExports: {
    logAdminAudit: async () => {},
  },
});

const ENV = { QBO_ENVIRONMENT: "sandbox" };
const MAPPING_DOC = "qboConfig/accountingMapping";

const actor = {
  token: { uid: "uid-1", email: "admin@example.com" },
  record: { email: "admin@example.com" },
} as unknown as AdminActor;

const FULL_MAPPING = {
  stripeClearingAccountId: "acct-1",
  tourIncomeItemId: "item-tour",
  tastingIncomeItemId: "item-tasting",
  otherIncomeItemId: "item-other",
  fallbackCustomerId: "cust-1",
};

function reset(
  seed: Record<string, Record<string, unknown>> = {},
  entities?: Record<string, QboEntitySummary[]>
) {
  firestore.reset({
    "qboConnections/sandbox": {
      environment: "sandbox",
      status: "connected",
      realmId: "realm-1",
    },
    ...seed,
  });
  state.entities = entities ?? {
    account: [
      { id: "acct-1", name: "Stripe Balance", type: "Bank", active: true },
    ],
    item: [
      { id: "item-tour", name: "Brewery Tour", type: "Service", active: true },
      { id: "item-tasting", name: "Tasting", type: "Service", active: true },
      { id: "item-other", name: "Other Income", type: "Service", active: true },
      {
        id: "item-inactive",
        name: "Retired Item",
        type: "Service",
        active: false,
      },
    ],
    customer: [{ id: "cust-1", name: "Stripe Checkout", active: true }],
    "tax-code": [{ id: "tax-1", name: "Out of scope", active: true }],
  };
  state.tokenError = null;
}

async function view() {
  const { getQboMappingView } = await import("@/lib/qbo-mapping");
  return withEnv(ENV, () => getQboMappingView());
}

async function configured(realmId = "realm-1") {
  const { getQboMappingConfigured } = await import("@/lib/qbo-mapping");
  return withEnv(ENV, () => getQboMappingConfigured("sandbox", realmId));
}

async function save(input: unknown) {
  const { saveQboMapping } = await import("@/lib/qbo-mapping");
  return withEnv(ENV, () => saveQboMapping(actor, input));
}

function mappingDoc() {
  return firestore.docs.get(MAPPING_DOC);
}

describe("getQboMappingView — realm/environment binding", () => {
  it("reports not configured when no mapping document exists", async () => {
    reset();
    const result = await view();
    assert.strictEqual(result.configured, false);
    assert.strictEqual(await configured(), false);
  });

  it("ignores a document bound to a different realm", async () => {
    reset({
      [MAPPING_DOC]: {
        ...FULL_MAPPING,
        environment: "sandbox",
        realmId: "realm-other",
      },
    });
    assert.strictEqual((await view()).configured, false);
    assert.strictEqual(await configured(), false);
  });

  it("ignores a document bound to a different environment", async () => {
    reset({
      [MAPPING_DOC]: {
        ...FULL_MAPPING,
        environment: "production",
        realmId: "realm-1",
      },
    });
    assert.strictEqual((await view()).configured, false);
    assert.strictEqual(await configured(), false);
  });

  it("reports a complete bound mapping with no missing fields", async () => {
    reset({
      [MAPPING_DOC]: {
        ...FULL_MAPPING,
        environment: "sandbox",
        realmId: "realm-1",
        entityNames: { "acct-1": "Stripe Balance" },
      },
    });
    const result = await view();
    assert.strictEqual(result.configured, true);
    assert.deepStrictEqual(result.missingFields, []);
    assert.strictEqual(result.mapping?.stripeClearingAccountId, "acct-1");
    assert.strictEqual(result.entityNames?.["acct-1"], "Stripe Balance");
    assert.strictEqual(await configured(), true);
  });

  it("flags a stored mapping missing required fields as incomplete", async () => {
    // A document that predates required-field enforcement: it is still
    // "configured" (bound, usable ids) but must never read as complete.
    reset({
      [MAPPING_DOC]: {
        stripeClearingAccountId: "acct-1",
        tourIncomeItemId: "item-tour",
        environment: "sandbox",
        realmId: "realm-1",
      },
    });
    const result = await view();
    assert.strictEqual(result.configured, true);
    assert.deepStrictEqual(result.missingFields, [
      "tastingIncomeItemId",
      "otherIncomeItemId",
      "fallbackCustomerId",
    ]);
    // The connection-level "mapping configured" flag only means ready to post.
    assert.strictEqual(await configured(), false);
  });
});

describe("saveQboMapping — required-field enforcement", () => {
  it("requires a live connection before anything can be saved", async () => {
    reset({ "qboConnections/sandbox": { status: "disconnected" } });
    await assert.rejects(save(FULL_MAPPING), (error) => {
      assert.ok(error instanceof QboError);
      assert.strictEqual(error.kind, "validation");
      assert.match(error.message, /must be connected/);
      return true;
    });
  });

  it("rejects a payload missing any required field and names the labels", async () => {
    reset();
    const partial: Record<string, string> = { ...FULL_MAPPING };
    delete partial.tastingIncomeItemId;
    await assert.rejects(save(partial), (error) => {
      assert.ok(error instanceof QboError);
      assert.strictEqual(error.kind, "validation");
      assert.match(error.message, /Tasting income item/);
      return true;
    });
    assert.strictEqual(mappingDoc(), undefined, "no partial write");
  });

  it("rejects each required field being absent", async () => {
    for (const [key, label] of [
      ["stripeClearingAccountId", "Stripe clearing account"],
      ["tourIncomeItemId", "Tour income item"],
      ["tastingIncomeItemId", "Tasting income item"],
      ["otherIncomeItemId", "Other income item"],
      ["fallbackCustomerId", "Generic sales customer"],
    ] as const) {
      reset();
      const partial = { ...FULL_MAPPING, [key]: undefined };
      await assert.rejects(save(partial), (error) => {
        assert.ok(error instanceof QboError);
        assert.match(error.message, new RegExp(label));
        return true;
      });
    }
  });

  it("saves a complete mapping without a tax code — tax stays optional", async () => {
    reset();
    const result = await save(FULL_MAPPING);
    assert.strictEqual(result.configured, true);
    assert.deepStrictEqual(result.missingFields, []);
    const doc = mappingDoc();
    assert.strictEqual(doc?.environment, "sandbox");
    assert.strictEqual(doc?.realmId, "realm-1");
    assert.strictEqual(doc?.taxCodeId, undefined);
    assert.strictEqual(
      (doc?.entityNames as Record<string, string>)["acct-1"],
      "Stripe Balance"
    );
  });

  it("accepts an optional tax code when one is selected", async () => {
    reset();
    const result = await save({ ...FULL_MAPPING, taxCodeId: "tax-1" });
    assert.strictEqual(result.configured, true);
    assert.strictEqual(mappingDoc()?.taxCodeId, "tax-1");
  });

  it("accepts an optional cash deposit account when one is selected (#206)", async () => {
    reset(undefined, {
      account: [
        { id: "acct-1", name: "Stripe Balance", type: "Bank", active: true },
        { id: "acct-cash", name: "Cash on hand", type: "Bank", active: true },
      ],
      item: [
        { id: "item-tour", name: "Brewery Tour", type: "Service", active: true },
        { id: "item-tasting", name: "Tasting", type: "Service", active: true },
        { id: "item-other", name: "Other Income", type: "Service", active: true },
      ],
      customer: [{ id: "cust-1", name: "Stripe Checkout", active: true }],
      "tax-code": [],
    });
    const result = await save({
      ...FULL_MAPPING,
      cashDepositAccountId: "acct-cash",
    });
    assert.strictEqual(result.configured, true);
    assert.strictEqual(mappingDoc()?.cashDepositAccountId, "acct-cash");
  });

  it("rejects a cash deposit account that does not resolve in the company", async () => {
    reset();
    await assert.rejects(
      save({ ...FULL_MAPPING, cashDepositAccountId: "acct-nope" }),
      (error) => {
        assert.ok(error instanceof QboError);
        assert.match(error.message, /Cash deposit account/);
        return true;
      }
    );
    assert.strictEqual(mappingDoc(), undefined);
  });

  it("rejects malformed ids before any provider lookup", async () => {
    reset();
    await assert.rejects(
      save({ ...FULL_MAPPING, stripeClearingAccountId: "not a real id!" }),
      (error) => {
        assert.ok(error instanceof QboError);
        assert.match(error.message, /Stripe clearing account/);
        return true;
      }
    );
    assert.strictEqual(mappingDoc(), undefined);
  });

  it("rejects an id that does not exist in the connected company", async () => {
    reset();
    await assert.rejects(
      save({ ...FULL_MAPPING, tourIncomeItemId: "item-missing" }),
      (error) => {
        assert.ok(error instanceof QboError);
        assert.match(error.message, /does not exist/);
        return true;
      }
    );
    assert.strictEqual(mappingDoc(), undefined);
  });

  it("rejects an id of the wrong entity type", async () => {
    reset();
    // A valid item id presented as the clearing account — validated
    // against the account list, where it is not a member.
    await assert.rejects(
      save({ ...FULL_MAPPING, stripeClearingAccountId: "item-tour" }),
      (error) => {
        assert.ok(error instanceof QboError);
        assert.match(error.message, /Stripe clearing account/);
        assert.match(error.message, /does not exist/);
        return true;
      }
    );
  });

  it("rejects an inactive entity rather than storing a doomed mapping", async () => {
    reset();
    await assert.rejects(
      save({ ...FULL_MAPPING, tourIncomeItemId: "item-inactive" }),
      (error) => {
        assert.ok(error instanceof QboError);
        assert.match(error.message, /inactive/);
        return true;
      }
    );
    assert.strictEqual(mappingDoc(), undefined);
  });
});
