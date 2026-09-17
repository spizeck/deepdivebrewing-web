import { test, expect } from "./fixtures";
import { scanAxe, formatBlocking, waitForAnimations } from "./axe-helpers";

// Accessibility coverage for the AUTHENTICATED admin dashboard, which the
// public-route spec cannot reach. The suite renders the real AdminWorkspace /
// AdminAccessPanel markup via /admin-fixture — a route that only exists when
// the server was started with ADMIN_A11Y_FIXTURE=1 (the Playwright webServer
// sets it; normal deployments return 404). No real authentication, Firebase
// data, or production services are involved: component state is hardcoded
// fixture data and /api/admin/* calls are intercepted below.

const FIXTURE = "/admin-fixture";

const ADMINS_RESPONSE = {
  ok: true,
  users: [
    {
      uid: "u-super",
      email: "boss@example.com",
      displayName: "Boss Owner",
      role: "superadmin",
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    {
      uid: "u-admin",
      email: "manager@example.com",
      role: "admin",
      status: "active",
      createdAt: "2025-02-01T00:00:00.000Z",
    },
  ],
  invitations: [
    {
      id: "inv-1",
      email: "pending@example.com",
      role: "admin",
      status: "pending",
      invitedBy: "boss@example.com",
      createdAt: "2025-03-01T00:00:00.000Z",
    },
  ],
};

function mockAdminApi(page: import("playwright/test").Page) {
  return page.route("/api/admin/**", (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (method === "GET" && url.endsWith("/api/admin/users")) {
      return json(ADMINS_RESPONSE);
    }
    if (method === "POST" && url.endsWith("/api/admin/users")) {
      return json({ ok: true, emailSent: true });
    }
    if (method === "PATCH" || method === "DELETE") {
      return json({ ok: true });
    }
    if (method === "POST" && url.includes("/resend")) {
      return json({ ok: true, emailResent: true });
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });
}

// Open the Access tab and wait for the mocked admin list to render.
async function openAccessTab(page: import("playwright/test").Page) {
  await mockAdminApi(page);
  await page.getByRole("tab", { name: "Access" }).click();
  await expect(page.getByText("boss@example.com")).toBeVisible();
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

test("axe: authenticated admin workspace has no serious/critical violations", async ({
  page,
}) => {
  await mockAdminApi(page);
  await page.goto(FIXTURE);
  await waitForAnimations(page);

  // Radix unmounts inactive panels — scan each tab's rendered content.
  for (const [tab, label] of [
    [null, "beers"],
    ["Venues", "venues"],
    ["Access", "access"],
  ] as const) {
    if (tab) {
      await page.getByRole("tab", { name: tab }).click();
      if (tab === "Access") {
        await expect(page.getByText("boss@example.com")).toBeVisible();
      }
    }
    const blocking = await scanAxe(page, `${FIXTURE} (${label} tab)`);
    expect(blocking, formatBlocking(`${FIXTURE} (${label} tab)`, blocking)).toEqual(
      []
    );
  }
});

test("needs-rebuild badge is rendered outside the tablist", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const badge = page.getByText("Needs Rebuild");
  await expect(badge).toBeVisible();
  const insideTablist = await badge.evaluate(
    (el) => !!el.closest('[role="tablist"]')
  );
  expect(insideTablist).toBe(false);
});

test("record lists expose list semantics and a programmatic selected state", async ({
  page,
}) => {
  await page.goto(FIXTURE);

  const pilsner = page.getByRole("button", { name: "Saba Suds Pilsner" });
  const stout = page.getByRole("button", { name: "Mount Scenery Stout" });

  // Real list semantics: each record sits in a list item.
  expect(await pilsner.evaluate((el) => el.closest("ul > li") !== null)).toBe(
    true
  );

  await expect(pilsner).toHaveAttribute("aria-current", "true");
  await stout.click();
  await expect(stout).toHaveAttribute("aria-current", "true");
  await expect(pilsner).toHaveAttribute("aria-current", "false");

  // Selecting a record populates the form.
  await expect(page.getByLabel("Style")).toHaveValue("Stout");
});

test("New record button moves focus into the form", async ({ page }) => {
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: "New beer record" }).press("Enter");
  await expect(page.getByLabel("Name")).toBeFocused();
});

test("required record fields expose required state", async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.getByLabel("Name")).toHaveAttribute("required", "");
  await expect(page.getByLabel("Slug")).toHaveAttribute("required", "");
});

test("save validation failure and success are announced", async ({ page }) => {
  await page.goto(FIXTURE);

  // New empty record → validation error announced in the status region.
  await page.getByRole("button", { name: "New beer record" }).press("Enter");
  await page.getByRole("button", { name: "Save Beer" }).press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "Beer name and slug are required."
  );

  // Filling required fields then saving announces success.
  await page.getByLabel("Name").fill("Test Beer");
  await page.getByLabel("Slug").fill("test-beer");
  await page.getByRole("button", { name: "Save Beer" }).press("Enter");
  await expect(page.getByRole("status")).toContainText("Beer saved.");
});

test("rebuild action announces its result and cooldown state", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: "Rebuild Site" }).press("Enter");
  await expect(page.getByRole("status")).toContainText("Rebuild triggered.");
  const cooldown = page.getByRole("button", { name: /Rebuild cooldown/ });
  await expect(cooldown).toBeDisabled();
});

test("tabs are keyboard operable with arrow keys", async ({ page }) => {
  await page.goto(FIXTURE);
  const beers = page.getByRole("tab", { name: "Beers" });
  const venues = page.getByRole("tab", { name: "Venues" });
  await beers.focus();
  await page.keyboard.press("ArrowRight");
  await expect(venues).toBeFocused();
  await expect(venues).toHaveAttribute("aria-selected", "true");
  await expect(beers).toHaveAttribute("aria-selected", "false");
});

test("non-superadmin view hides the Access tab", async ({ page }) => {
  await page.goto(`${FIXTURE}?role=admin`);
  await expect(page.getByRole("tab", { name: "Access" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Venues" })).toBeVisible();
});

test("invite form has labels, required state, and announces the result", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await openAccessTab(page);

  // Role-based query uses the accessible name ("Email"); the required "*" is
  // aria-hidden and the resend button's aria-label doesn't collide.
  const email = page.getByRole("textbox", { name: "Email" });
  await expect(email).toHaveAttribute("type", "email");
  await expect(email).toHaveAttribute("required", "");

  await email.fill("newadmin@example.com");
  await page.getByRole("button", { name: "Invite" }).press("Enter");

  await expect(
    page.getByRole("status").filter({ hasText: "Invitation created and email sent" })
  ).toContainText("newadmin@example.com");
});

test("admin row actions name their target and revoke is destructive", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await openAccessTab(page);

  await expect(
    page.getByRole("button", { name: "Promote manager@example.com to superadmin" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Demote boss@example.com to admin" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disable admin access for manager@example.com" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revoke admin access for manager@example.com" })
  ).toHaveAttribute("data-variant", "destructive");
});

test("status-changing action confirms with a named dialog and announces result", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await openAccessTab(page);

  let confirmMessage = "";
  page.on("dialog", (dialog) => {
    confirmMessage = dialog.message();
    void dialog.accept();
  });

  await page
    .getByRole("button", { name: "Disable admin access for manager@example.com" })
    .press("Enter");

  expect(confirmMessage).toContain("manager@example.com");
  // The action re-loads the list, so the "Loading..." status coexists
  // briefly — match the result region by content.
  await expect(
    page.getByRole("status").filter({ hasText: "Administrator updated." })
  ).toBeVisible();
});

test("invitation resend announces its result", async ({ page }) => {
  await page.goto(FIXTURE);
  await openAccessTab(page);

  await page
    .getByRole("button", { name: "Resend invitation email to pending@example.com" })
    .press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Invitation email resent." })
  ).toBeVisible();
});

test("admin list loading state is announced", async ({ page }) => {
  // Delay the list response so the loading state is observable.
  await page.route("/api/admin/users", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ADMINS_RESPONSE),
    });
  });
  await page.goto(FIXTURE);
  await page.getByRole("tab", { name: "Access" }).click();
  await expect(page.getByRole("status")).toContainText("Loading...");
  await expect(page.getByText("boss@example.com")).toBeVisible();
});
