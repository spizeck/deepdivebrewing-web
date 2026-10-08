import { test, expect } from "./fixtures";
import { scanAxe, formatBlocking, waitForAnimations } from "./axe-helpers";

// QuickBooks Online admin surface (Issue #161), rendered via
// /admin-quickbooks-fixture — a route that only exists when the server was
// started with ADMIN_A11Y_FIXTURE=1 (the Playwright webServer sets it;
// normal deployments return 404). No real authentication, Firebase data,
// or Intuit traffic is involved: /api/admin/quickbooks/* calls are
// intercepted by the route mocks below (registered after the default
// not-configured stub in fixtures.ts, so they win).

const FIXTURE = "/admin-quickbooks-fixture";

const CONNECTED = {
  ok: true,
  connection: {
    configured: true,
    environment: "sandbox",
    environmentLabel: "Sandbox",
    status: "connected",
    health: "healthy",
    realmIdShort: "1234…7890",
    companyName: "Deep Dive Brewing Sandbox",
    connectedAt: "2026-10-01T12:00:00.000Z",
    connectedByEmail: "admin@example.com",
    lastCheckAt: "2026-10-02T12:00:00.000Z",
    mappingConfigured: false,
  },
  mapping: { configured: false },
};

const REAUTHORIZE = {
  ok: true,
  connection: {
    configured: true,
    environment: "sandbox",
    environmentLabel: "Sandbox",
    status: "reauthorization_required",
    health: "needs_reauthorization",
    realmIdShort: "1234…7890",
    companyName: "Deep Dive Brewing Sandbox",
    connectedAt: "2026-10-01T12:00:00.000Z",
    connectedByEmail: "admin@example.com",
    mappingConfigured: false,
  },
  mapping: { configured: false },
};

const DISCONNECTED = {
  ok: true,
  connection: {
    configured: true,
    environment: "sandbox",
    environmentLabel: "Sandbox",
    status: "disconnected",
    health: "unknown",
    mappingConfigured: false,
  },
  mapping: { configured: false },
};

// Discovery entities the editor selects from — keyed by the `type`
// query parameter.
const ENTITIES = {
  account: [
    { id: "acct-1", name: "Stripe Balance", type: "Bank", active: true },
  ],
  item: [
    { id: "item-tour", name: "Brewery Tour", type: "Service", active: true },
    { id: "item-tasting", name: "Tasting", type: "Service", active: true },
    { id: "item-other", name: "Other Income", type: "Service", active: true },
  ],
  customer: [
    { id: "cust-1", name: "Stripe Checkout", active: true },
  ],
  "tax-code": [
    { id: "tax-1", name: "Out of scope", active: true },
  ],
};

const FULL_MAPPING_INPUT = {
  stripeClearingAccountId: "acct-1",
  tourIncomeItemId: "item-tour",
  tastingIncomeItemId: "item-tasting",
  otherIncomeItemId: "item-other",
  fallbackCustomerId: "cust-1",
};

function mockQboApi(
  page: import("playwright/test").Page,
  statusBody: unknown,
  overrides: {
    disconnectBody?: unknown;
    testBody?: unknown;
    connectBody?: unknown;
    entities?: Record<string, unknown[]>;
    /** Inspect or replace the mapping PUT — return a response body to
     *  override the default echo-back. */
    onMappingPut?: (body: Record<string, unknown>) => unknown | void;
  } = {}
) {
  return page.route(/\/api\/admin\/quickbooks\//, (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (method === "GET" && url.endsWith("/api/admin/quickbooks/status")) {
      return json(statusBody);
    }
    if (
      method === "GET" &&
      url.includes("/api/admin/quickbooks/entities")
    ) {
      const type = new URL(url).searchParams.get("type") ?? "";
      return json({ ok: true, entities: overrides.entities?.[type] ?? [] });
    }
    if (
      method === "PUT" &&
      url.endsWith("/api/admin/quickbooks/mapping")
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const replacement = overrides.onMappingPut?.(body);
      return json(
        replacement ?? {
          ok: true,
          mapping: {
            configured: true,
            missingFields: [],
            mapping: body,
            entityNames: Object.fromEntries(
              Object.values(overrides.entities ?? {})
                .flat()
                .map((entity) => [
                  (entity as { id: string }).id,
                  (entity as { name: string }).name,
                ])
            ),
          },
        }
      );
    }
    if (method === "POST" && url.endsWith("/api/admin/quickbooks/test")) {
      return json(overrides.testBody ?? statusBody);
    }
    if (
      method === "POST" &&
      url.endsWith("/api/admin/quickbooks/disconnect")
    ) {
      return json(overrides.disconnectBody ?? DISCONNECTED);
    }
    if (method === "POST" && url.endsWith("/api/admin/quickbooks/connect")) {
      return json(
        overrides.connectBody ?? {
          ok: true,
          authorizationUrl: "https://appcenter.intuit.com/connect/oauth2",
        }
      );
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });
}

test.beforeAll(async ({ request }) => {
  const res = await request.get(FIXTURE);
  if (res.status() === 404) {
    throw new Error(
      `${FIXTURE} returned 404 — the suite requires the Playwright-managed ` +
        "server (started with ADMIN_A11Y_FIXTURE=1 via playwright.config.ts). " +
        "Stop any other server on the configured port and rerun."
    );
  }
});

test("not-configured state explains setup without offering connect", async ({
  page,
}) => {
  // The default fixture stub returns not_configured — no route override.
  await page.goto(FIXTURE);
  await expect(
    page.getByRole("heading", { name: "QuickBooks Online" })
  ).toBeVisible();
  await expect(
    page.getByText("Not configured", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(/credentials are not set on this deployment/)
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Connect QuickBooks/ })
  ).toHaveCount(0);
});

test("disconnected state offers connect and shows the sandbox badge", async ({
  page,
}) => {
  await mockQboApi(page, DISCONNECTED);
  await page.goto(FIXTURE);
  await expect(
    page.getByText("Not connected", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Sandbox", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect QuickBooks" })
  ).toBeVisible();
  await expect(
    page.getByText("Accounting mapping not configured.")
  ).toBeVisible();
});

test("connected state shows company identity and control set", async ({
  page,
}) => {
  await mockQboApi(page, CONNECTED);
  await page.goto(FIXTURE);
  // "Connected" appears as both the status badge and the <dt> label for
  // the connected-at timestamp — assert on the badge text's first match.
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(page.getByText("Deep Dive Brewing Sandbox")).toBeVisible();
  await expect(page.getByText("1234…7890")).toBeVisible();
  await expect(page.getByText("admin@example.com")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test connection" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disconnect" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Configure mapping" })
  ).toBeVisible();
});

test("test connection reports the refreshed status", async ({ page }) => {
  await mockQboApi(page, CONNECTED);
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: "Test connection" }).press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Connection check succeeded." })
  ).toBeVisible();
});

test("disconnect requires the confirmation dialog", async ({ page }) => {
  await mockQboApi(page, CONNECTED);
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: "Disconnect" }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Disconnect QuickBooks?" })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Disconnect", exact: true })
    .last()
    .press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "QuickBooks disconnected." })
  ).toBeVisible();
});

test("reauthorization state shows reconnect guidance", async ({ page }) => {
  await mockQboApi(page, REAUTHORIZE);
  await page.goto(FIXTURE);
  await expect(
    page.getByText("Reconnect required", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(/no longer accepts the stored authorization/)
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect QuickBooks" })
  ).toBeVisible();
});

test("a complete mapping lists the selected entities under the finalized labels", async ({
  page,
}) => {
  await mockQboApi(page, {
    ok: true,
    connection: CONNECTED.connection,
    mapping: {
      configured: true,
      mapping: FULL_MAPPING_INPUT,
      missingFields: [],
      entityNames: {
        "acct-1": "Stripe Balance",
        "item-tour": "Brewery Tour",
        "item-tasting": "Tasting",
        "item-other": "Other Income",
        "cust-1": "Stripe Checkout",
      },
    },
  });
  await page.goto(FIXTURE);
  await expect(
    page.getByText("Sales receipts post to these QuickBooks entities.")
  ).toBeVisible();
  await expect(
    page.getByText("Stripe clearing account", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Generic sales customer", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Tax code (optional)", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Stripe Balance")).toBeVisible();
  await expect(page.getByText("Stripe Checkout")).toBeVisible();
});

test("an incomplete mapping names the missing required fields", async ({
  page,
}) => {
  await mockQboApi(page, {
    ok: true,
    connection: CONNECTED.connection,
    mapping: {
      configured: true,
      mapping: { stripeClearingAccountId: "acct-1" },
      missingFields: [
        "tourIncomeItemId",
        "tastingIncomeItemId",
        "otherIncomeItemId",
        "fallbackCustomerId",
      ],
      entityNames: { "acct-1": "Stripe Balance" },
    },
  });
  await page.goto(FIXTURE);
  await expect(page.getByText(/Mapping incomplete/)).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Missing required fields: Tour income item/ })
  ).toBeVisible();
  await expect(page.getByText("Stripe Balance")).toBeVisible();
  await expect(page.getByText("Not set — required")).toHaveCount(4);
});

test("the mapping editor blocks save until every required field is set", async ({
  page,
}) => {
  let putBody: Record<string, unknown> | null = null;
  await mockQboApi(page, CONNECTED, {
    entities: ENTITIES,
    onMappingPut: (body) => {
      putBody = body;
    },
  });
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: "Configure mapping" }).press("Enter");

  const save = page.getByRole("button", { name: "Save mapping" });
  await expect(save).toBeDisabled();
  await expect(page.getByText(/Still required:/)).toBeVisible();
  await expect(page.getByText("(required)")).toHaveCount(5);

  await page
    .getByLabel(/Stripe clearing account/)
    .selectOption("acct-1");
  await page.getByLabel(/Tour income item/).selectOption("item-tour");
  await page.getByLabel(/Tasting income item/).selectOption("item-tasting");
  await page.getByLabel(/Other income item/).selectOption("item-other");
  await page
    .getByLabel(/Generic sales customer/)
    .selectOption("cust-1");

  await expect(save).toBeEnabled();
  await save.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Mapping saved." })
  ).toBeVisible();

  expect(putBody).toMatchObject(FULL_MAPPING_INPUT);
  // The saved view echoes the resolved entity names.
  await expect(page.getByText("Stripe Balance")).toBeVisible();
  await expect(page.getByText("Stripe Checkout")).toBeVisible();
});

test("axe: quickbooks workspace has no serious/critical violations", async ({
  page,
}) => {
  await mockQboApi(page, CONNECTED);
  await page.goto(FIXTURE);
  await waitForAnimations(page);
  await expect(page.getByText("Deep Dive Brewing Sandbox")).toBeVisible();
  const blocking = await scanAxe(page, `${FIXTURE} (connected)`);
  expect(blocking, formatBlocking(`${FIXTURE} (connected)`, blocking)).toEqual(
    []
  );
});
