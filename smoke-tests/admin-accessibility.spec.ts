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
      permissions: ["payments"],
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

test("limited admin sees payments but not QuickBooks navigation (#210)", async ({
  page,
}) => {
  // The fixture's plain admin holds "payments" only — the payments card is
  // the entry point to /admin/payments and the QuickBooks card must not
  // render at all (UI hiding is convenience; the APIs still 403).
  await page.goto(`${FIXTURE}?role=admin`);
  await expect(
    page.getByRole("link", { name: "Take payment" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open QuickBooks" })
  ).toHaveCount(0);
});

test("superadmin sees both payments and QuickBooks navigation (#210)", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await expect(
    page.getByRole("link", { name: "Take payment" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open QuickBooks" })
  ).toBeVisible();
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

test("invite form ignores re-submission while a request is in flight", async ({
  page,
}) => {
  // Enter inside the email field re-submits the form even though the submit
  // button is disabled — the in-flight guard must keep a second press from
  // posting a duplicate invitation.
  await page.goto(FIXTURE);
  await openAccessTab(page);

  let invitePosts = 0;
  // Released after the second Enter, so the first request is guaranteed
  // in-flight while the re-submission attempt happens — no timing guesses.
  let releaseInvite!: () => void;
  const inviteGate = new Promise<void>((resolve) => {
    releaseInvite = resolve;
  });
  // Registered after openAccessTab's default mock, so this override wins for
  // the invite POST while leaving the earlier GET untouched.
  await page.route("/api/admin/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (method === "POST" && url.endsWith("/api/admin/users")) {
      invitePosts += 1;
      await inviteGate;
      return json({ ok: true, emailSent: true });
    }
    if (method === "GET" && url.endsWith("/api/admin/users")) {
      return json(ADMINS_RESPONSE);
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });

  const email = page.getByRole("textbox", { name: "Email" });
  await email.fill("newadmin@example.com");
  await email.press("Enter");
  await email.press("Enter");
  releaseInvite();

  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Invitation created and email sent" })
  ).toBeVisible();
  expect(invitePosts).toBe(1);
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

test("permission checkboxes reflect state and PATCH the capability set (#210)", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await openAccessTab(page);

  // The superadmin row carries an implicit-all note instead of checkboxes.
  await expect(
    page.getByText("Holds every permission as a superadmin.")
  ).toBeVisible();

  let patchedBody: unknown;
  // Later registration wins — intercept the permissions PATCH and the
  // list reload so the refetched record reflects the granted capability
  // (the panel reloads after a successful update, and a static response
  // would flip the checkbox back before .check() finishes verifying).
  let grantedPermissions = ["payments"];
  await page.route(/\/api\/admin\/users(\/u-admin)?$/, (route) => {
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (method === "PATCH") {
      patchedBody = route.request().postDataJSON();
      grantedPermissions = (patchedBody as { permissions: string[] })
        .permissions;
      return json({ ok: true });
    }
    if (method === "GET" && route.request().url().endsWith("/api/admin/users")) {
      return json({
        ...ADMINS_RESPONSE,
        users: ADMINS_RESPONSE.users.map((u) =>
          u.uid === "u-admin" ? { ...u, permissions: grantedPermissions } : u
        ),
      });
    }
    return route.fallback();
  });

  const paymentsBox = page.getByRole("checkbox", { name: /Take Payments/ });
  const accountingBox = page.getByRole("checkbox", {
    name: /QuickBooks & Accounting/,
  });
  await expect(paymentsBox).toBeChecked();
  await expect(accountingBox).not.toBeChecked();

  // Controlled input: checked only flips after the PATCH + refetch round
  // trip, so click and let the status message gate the assertions.
  await accountingBox.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Permissions updated" })
  ).toBeVisible();
  await expect(accountingBox).toBeChecked();
  expect(patchedBody).toEqual({ permissions: ["payments", "accounting"] });
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

// --- Trade-lead pipeline fixture (Issue #150) ---

const TRADE_FIXTURE = "/admin-trade-fixture";

const TRADE_LEAD = {
  id: "lead-1",
  businessName: "Fixture Harbour Bar",
  contactName: "Sam Keeper",
  email: "sam@harbour.example",
  phoneOrWhatsapp: "+599 555 1234",
  phoneDisplay: "+599 555 1234",
  phoneE164: "+5995551234",
  venueType: "bar",
  island: "saba",
  message: "Interested in carrying the Pilsner.",
  status: "contacted",
  source: "trade_form",
  assignedToName: "Chad",
  assignedToUid: "u-1",
  nextFollowUpAt: "2026-10-18T04:00:00.000Z",
  inboundAddress: "7K4M2QX9@reply.deepdivebrewing.com",
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
  lastActivityAt: "2026-10-02T12:00:00.000Z",
};

const TRADE_ACTIVITIES = [
  {
    id: "a-0",
    type: "lead_created",
    seq: 0,
    details: { source: "trade_form" },
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  {
    id: "a-1",
    type: "note",
    seq: 1,
    authorUid: "u-1",
    authorName: "Chad",
    body: "Spoke on WhatsApp. Interested in the Pilsner.",
    createdAt: "2026-10-02T12:00:00.000Z",
  },
  {
    id: "a-2",
    type: "communication",
    seq: 2,
    authorUid: "u-1",
    authorName: "Chad",
    communication: {
      channel: "email",
      direction: "outbound",
      communicationId: "comm-1",
      subject: "Wholesale pricing",
      preview: "Thanks for reaching out —",
      deliveryState: "sent",
      threadId: "comm-1",
    },
    createdAt: "2026-10-02T14:00:00.000Z",
  },
  {
    id: "a-3",
    type: "communication",
    seq: 3,
    communication: {
      channel: "email",
      direction: "inbound",
      communicationId: "inb_1",
      subject: "Re: Wholesale pricing",
      preview: "Looks good —",
      threadId: "comm-1",
    },
    createdAt: "2026-10-02T16:00:00.000Z",
  },
];

const TRADE_COMMUNICATIONS = [
  {
    id: "comm-1",
    channel: "email",
    direction: "outbound",
    to: ["sam@harbour.example"],
    subject: "Wholesale pricing",
    textBody: "Thanks for reaching out — here is the current price list.",
    providerEmailId: "re_1",
    messageId: "<comm-1@mail.deepdivebrewing.com>",
    threadId: "comm-1",
    sentAt: "2026-10-02T14:00:00.000Z",
    sentByName: "Chad",
    deliveryState: "delivered",
    createdAt: "2026-10-02T14:00:00.000Z",
  },
  {
    id: "inb_1",
    channel: "email",
    direction: "inbound",
    from: "sam@harbour.example",
    to: ["7K4M2QX9@reply.deepdivebrewing.com"],
    subject: "Re: Wholesale pricing",
    textBody: "Looks good — send two cases to start.",
    threadId: "comm-1",
    deliveryState: "received",
    createdAt: "2026-10-02T16:00:00.000Z",
  },
];

function mockTradeApi(page: import("playwright/test").Page) {
  return page.route(/\/api\/admin\/trade-leads/, (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (method === "GET" && url.endsWith("/api/admin/trade-leads")) {
      return json({
        ok: true,
        leads: [TRADE_LEAD],
        admins: [{ uid: "u-1", name: "Chad" }],
      });
    }
    if (method === "GET" && url.includes("/api/admin/trade-leads/")) {
      return json({
        ok: true,
        lead: TRADE_LEAD,
        activities: TRADE_ACTIVITIES,
        communications: TRADE_COMMUNICATIONS,
      });
    }
    if (method === "PATCH" || method === "POST") {
      return json({
        ok: true,
        lead: TRADE_LEAD,
        activities: TRADE_ACTIVITIES,
        communications: TRADE_COMMUNICATIONS,
      });
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });
}

test("axe: trade-lead pipeline workspace has no serious/critical violations", async ({
  page,
}) => {
  await mockTradeApi(page);
  await page.goto(TRADE_FIXTURE);
  await waitForAnimations(page);
  await expect(page.getByText("Fixture Harbour Bar")).toBeVisible();

  // List view.
  let blocking = await scanAxe(page, `${TRADE_FIXTURE} (list)`);
  expect(blocking, formatBlocking(`${TRADE_FIXTURE} (list)`, blocking)).toEqual(
    []
  );

  // Detail workspace with the populated history timeline (includes
  // outbound/inbound email entries and the attach-address block).
  await page.getByRole("button", { name: /Fixture Harbour Bar/ }).press("Enter");
  await expect(page.getByText("Spoke on WhatsApp")).toBeVisible();
  await expect(page.getByText("Email received — Re: Wholesale pricing")).toBeVisible();
  await expect(
    page.getByText("7K4M2QX9@reply.deepdivebrewing.com")
  ).toBeVisible();
  blocking = await scanAxe(page, `${TRADE_FIXTURE} (detail)`);
  expect(
    blocking,
    formatBlocking(`${TRADE_FIXTURE} (detail)`, blocking)
  ).toEqual([]);

  // The email composer (labeled To/Subject/Message controls).
  await page.getByRole("button", { name: "Email this lead" }).press("Enter");
  await expect(page.getByRole("textbox", { name: "Subject" })).toBeVisible();
  blocking = await scanAxe(page, `${TRADE_FIXTURE} (composer)`);
  expect(
    blocking,
    formatBlocking(`${TRADE_FIXTURE} (composer)`, blocking)
  ).toEqual([]);
});

test("trade-lead list announces loading and rows expose selected state", async ({
  page,
}) => {
  await mockTradeApi(page);
  await page.goto(TRADE_FIXTURE);
  const row = page.getByRole("button", { name: /Fixture Harbour Bar/ });
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => el.closest("ul > li") !== null)).toBe(true);
  await row.press("Enter");
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("heading", { name: "Fixture Harbour Bar" })
  ).toBeVisible();
});

test("trade-lead email composer sends to the lead address and reports success", async ({
  page,
}) => {
  await mockTradeApi(page);
  // Registered after the generic trade mock so the more specific pattern
  // wins (Playwright consults routes in reverse registration order).
  let sentBody: unknown;
  await page.route(/\/api\/admin\/trade-leads\/lead-1\/messages/, (route) => {
    sentBody = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        lead: TRADE_LEAD,
        activities: TRADE_ACTIVITIES,
        communications: TRADE_COMMUNICATIONS,
      }),
    });
  });
  await page.goto(TRADE_FIXTURE);
  await page.getByRole("button", { name: /Fixture Harbour Bar/ }).press("Enter");
  await page.getByRole("button", { name: "Email this lead" }).press("Enter");

  // The recipient is the lead's address, shown read-only — the composer
  // cannot aim email elsewhere.
  await expect(
    page.getByLabel("To", { exact: true })
  ).toHaveValue("sam@harbour.example");

  await page.getByRole("textbox", { name: "Subject" }).fill("Pricing");
  await page.getByRole("textbox", { name: "Message" }).fill("Hello there");
  await page.getByRole("button", { name: "Send email" }).press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Email sent." })
  ).toBeVisible();
  expect(sentBody).toMatchObject({ subject: "Pricing", body: "Hello there" });
});

test("trade-lead note entry is labeled and announces its result", async ({
  page,
}) => {
  await mockTradeApi(page);
  await page.goto(TRADE_FIXTURE);
  await page.getByRole("button", { name: /Fixture Harbour Bar/ }).press("Enter");
  await expect(page.getByText("Spoke on WhatsApp")).toBeVisible();

  const noteBox = page.getByRole("textbox", { name: "Add a note" });
  await noteBox.fill("Dropped off samples.");
  await page.getByRole("button", { name: "Add note" }).press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Note added." })
  ).toBeVisible();
});

// --- Payments workspace fixture (Issue #155) ---

const PAYMENTS_FIXTURE = "/admin-payments-fixture";

const PAYMENT = {
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  purpose: "brewery_tour_tasting",
  description: "Brewery Tour + Tasting",
  amountMinor: 8000,
  currency: "usd",
  customerName: "Dana Guest",
  customerEmail: "dana@example.com",
  tourDate: "2026-10-15",
  attendeeCount: 2,
  paymentMethod: "card",
  status: "awaiting_payment",
  livemode: false,
  createdByUid: "u-1",
  createdByName: "Chad",
  createdAt: "2026-10-03T12:00:00.000Z",
  stripeCheckoutSessionId: "cs_test_fixture",
  stripeSessionUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture",
  stripePaymentIntentId: "pi_fixture",
};

const PAYMENT_EVENTS = [
  {
    id: "e-0",
    type: "payment_created",
    seq: 0,
    actorUid: "u-1",
    actorName: "Chad",
    createdAt: "2026-10-03T12:00:00.000Z",
  },
  {
    id: "e-1",
    type: "checkout_session_created",
    seq: 1,
    actorUid: "u-1",
    actorName: "Chad",
    createdAt: "2026-10-03T12:00:01.000Z",
  },
];

// A cash payment (#206): born paid, carries the explicit rail, and has no
// Stripe identifiers at all.
const CASH_PAYMENT = {
  id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
  purpose: "other",
  description: "Walk-in merch",
  amountMinor: 2500,
  currency: "usd",
  customerName: "Walk-in Customer",
  internalNote: "counter sale",
  paymentMethod: "cash",
  status: "paid",
  paidAt: "2026-10-03T12:00:00.000Z",
  createdByUid: "u-1",
  createdByName: "Chad",
  createdAt: "2026-10-03T12:00:00.000Z",
};

const CASH_EVENTS = [
  {
    id: "ce-0",
    type: "payment_created",
    seq: 0,
    actorUid: "u-1",
    actorName: "Chad",
    createdAt: "2026-10-03T12:00:00.000Z",
  },
  {
    id: "ce-1",
    type: "cash_payment_recorded",
    seq: 1,
    actorUid: "u-1",
    actorName: "Chad",
    createdAt: "2026-10-03T12:00:00.000Z",
    details: { amountMinor: "2500" },
  },
];

function mockPaymentsApi(page: import("playwright/test").Page) {
  return page.route(/\/api\/admin\/payments/, (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (method === "GET" && url.endsWith("/api/admin/payments")) {
      return json({ ok: true, payments: [PAYMENT] });
    }
    if (method === "GET" && url.endsWith("/qr")) {
      return json({ ok: false, error: "QR not needed in fixture" }, 400);
    }
    if (method === "GET" && url.includes(CASH_PAYMENT.id)) {
      return json({ ok: true, payment: CASH_PAYMENT, events: CASH_EVENTS });
    }
    if (method === "GET" && url.includes("/api/admin/payments/")) {
      return json({ ok: true, payment: PAYMENT, events: PAYMENT_EVENTS });
    }
    if (method === "POST" && url.endsWith("/api/admin/payments")) {
      const body = route.request().postDataJSON() as {
        paymentMethod?: string;
      } | null;
      return json({
        ok: true,
        payment: body?.paymentMethod === "cash" ? CASH_PAYMENT : PAYMENT,
        replayed: false,
      });
    }
    if (method === "POST") {
      return json({ ok: true, payment: PAYMENT, events: PAYMENT_EVENTS });
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });
}

// A settled payment still inside the 1-hour in-app refund window.
const PAID_PAYMENT = {
  ...PAYMENT,
  status: "paid",
  paidAt: new Date().toISOString(),
};

const REFUND_EVENTS = [
  ...PAYMENT_EVENTS,
  {
    id: "e-2",
    type: "payment_succeeded",
    seq: 2,
    actorUid: null,
    actorName: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: "e-3",
    type: "refund_requested",
    seq: 3,
    actorUid: "u-1",
    actorName: "Chad",
    createdAt: new Date().toISOString(),
    details: { amountMinor: "8000", reason: "Duplicate charge" },
  },
  {
    id: "e-4",
    type: "refund_succeeded",
    seq: 4,
    actorUid: "u-1",
    actorName: "Chad",
    createdAt: new Date().toISOString(),
    details: { amountMinor: "8000" },
  },
];

const REFUNDED_PAYMENT = {
  ...PAID_PAYMENT,
  status: "refunded",
  stripeRefundId: "re_fixture_1",
  refundAmountMinor: 8000,
  refundCurrency: "usd",
  refundReason: "Duplicate charge",
  refundedByName: "Chad",
  refundRequestedAt: new Date().toISOString(),
  refundedAt: new Date().toISOString(),
  stripeRefundStatus: "succeeded",
};

function mockRefundablePaymentsApi(page: import("playwright/test").Page) {
  return page.route(/\/api\/admin\/payments/, (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (method === "GET" && url.endsWith("/api/admin/payments")) {
      return json({ ok: true, payments: [PAID_PAYMENT] });
    }
    if (method === "GET" && url.endsWith("/qr")) {
      return json({ ok: false, error: "QR not needed in fixture" }, 400);
    }
    if (method === "GET" && url.includes("/api/admin/payments/")) {
      return json({ ok: true, payment: PAID_PAYMENT, events: PAYMENT_EVENTS });
    }
    if (method === "POST" && url.includes("/refund")) {
      return json({
        ok: true,
        payment: REFUNDED_PAYMENT,
        events: REFUND_EVENTS,
      });
    }
    if (method === "POST") {
      return json({ ok: true, payment: PAID_PAYMENT, events: PAYMENT_EVENTS });
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });
}

test("axe: payments workspace has no serious/critical violations", async ({
  page,
}) => {
  await mockPaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  await waitForAnimations(page);
  await expect(page.getByText("Dana Guest")).toBeVisible();

  let blocking = await scanAxe(page, `${PAYMENTS_FIXTURE} (form + list)`);
  expect(
    blocking,
    formatBlocking(`${PAYMENTS_FIXTURE} (form + list)`, blocking)
  ).toEqual([]);

  // Detail panel with the event history.
  await page.getByRole("button", { name: /Dana Guest/ }).press("Enter");
  await expect(page.getByText("Payment link created")).toBeVisible();
  blocking = await scanAxe(page, `${PAYMENTS_FIXTURE} (detail)`);
  expect(
    blocking,
    formatBlocking(`${PAYMENTS_FIXTURE} (detail)`, blocking)
  ).toEqual([]);
});

test("cash method records the payment immediately and labels it everywhere", async ({
  page,
}) => {
  await mockPaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  await waitForAnimations(page);

  // Method selection sits inside the one take-payment flow.
  await page.getByRole("radio", { name: "Cash" }).check();
  await page.getByLabel("Customer name").fill("Walk-in Customer");
  await page.getByLabel("Amount (USD)").fill("25");
  await page.getByRole("button", { name: "Review payment" }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Confirm cash payment" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Record cash payment" }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Cash payment recorded" })
  ).toBeVisible();
  await expect(page.getByText("Payment received.")).toBeVisible();

  // The list row is labelled Cash.
  const row = page.getByRole("button", { name: /Walk-in Customer/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Cash");

  // Detail: the method is explicit and no Stripe internals are invented.
  await row.press("Enter");
  await expect(page.getByText("Cash payment recorded").first()).toBeVisible();
  await expect(page.getByText("Stripe session")).toHaveCount(0);
  await expect(page.getByText("PaymentIntent")).toHaveCount(0);
});

test("take-payment form validates the amount before review", async ({
  page,
}) => {
  await mockPaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  await expect(page.getByText("Dana Guest")).toBeVisible();

  await page.getByLabel("Customer name").fill("Fixture Person");
  await page.getByLabel("Amount (USD)").fill("0");
  await page.getByRole("button", { name: "Review payment" }).press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Amount must be greater than zero." })
  ).toBeVisible();
});

test("payment rows share the shared press feedback", async ({ page }) => {
  // The record-row pattern (beer/venue lists, trade leads) carries
  // pressableClasses; the payments list used to be the one row type without
  // a pressed state.
  await mockPaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  const row = page.getByRole("button", { name: /Dana Guest/ });
  await expect(row).toBeVisible();

  const timing = await row.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
    };
  });
  expect(timing.property).toContain("scale");
  expect(timing.duration).not.toBe("0s");

  await row.hover();
  await page.mouse.down();
  // Tailwind's scale-* utilities set the standalone `scale` property, not
  // `transform` — assert the property the press actually animates.
  const scale = await row.evaluate((el) => getComputedStyle(el).scale);
  await page.mouse.up();
  expect(scale).not.toBe("none");
});

test("payment-row press feedback never transforms under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockPaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  const row = page.getByRole("button", { name: /Dana Guest/ });
  await expect(row).toBeVisible();

  await row.hover();
  await page.mouse.down();
  const scale = await row.evaluate((el) => getComputedStyle(el).scale);
  await page.mouse.up();
  expect(scale).toBe("none");
});

test("payment rows expose list semantics and the form is labeled", async ({
  page,
}) => {
  await mockPaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  const row = page.getByRole("button", { name: /Dana Guest/ });
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => el.closest("ul > li") !== null)).toBe(
    true
  );

  await expect(page.getByLabel("Purpose")).toBeVisible();
  await expect(page.getByLabel(/Amount \(USD\)/)).toBeVisible();
  await expect(page.getByLabel(/Description/)).toBeVisible();
});

test("refund dialog gates the destructive action on reason + typed REFUND", async ({
  page,
}) => {
  await mockRefundablePaymentsApi(page);
  await page.goto(PAYMENTS_FIXTURE);
  await waitForAnimations(page);

  // A paid payment inside the window offers the refund action.
  await page.getByRole("button", { name: /Dana Guest/ }).press("Enter");
  await page.getByRole("button", { name: "Refund payment" }).press("Enter");

  const dialog = page.getByRole("dialog", { name: "Refund payment" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Refund amount")).toBeVisible();

  const submit = dialog.getByRole("button", { name: "Refund $80.00" });
  await expect(submit).toBeDisabled();

  // Reason alone is not enough…
  await dialog.getByLabel(/Refund reason/).fill("Duplicate charge");
  await expect(submit).toBeDisabled();

  // …and the confirmation is exact-match (lowercase does not count).
  await dialog.getByLabel(/to confirm/).fill("refund");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill("REFUND");
  await expect(submit).toBeEnabled();

  const blocking = await scanAxe(page, `${PAYMENTS_FIXTURE} (refund dialog)`);
  expect(
    blocking,
    formatBlocking(`${PAYMENTS_FIXTURE} (refund dialog)`, blocking)
  ).toEqual([]);

  await submit.press("Enter");
  await expect(page.getByText("Payment refunded.")).toBeVisible();
  await expect(page.getByText("Refund completed")).toBeVisible();
});
