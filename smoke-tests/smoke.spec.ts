import { test, expect } from "./fixtures";

// Deterministic smoke coverage for the production build. Assertions target
// user-visible semantics (headings, labels, links, buttons) that hold whether
// or not Firestore data is available — in CI the data layer resolves empty
// offline, locally it may return live content.

test("homepage renders brewery content and primary navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /deep dive/i })
  ).toBeVisible();
  // Primary site navigation.
  await expect(
    page.getByRole("link", { name: "Beers", exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Where to Buy" }).first()
  ).toBeVisible();
  // Meaningful brewery content.
  await expect(page.getByText(/brewed on saba/i).first()).toBeVisible();
});

test("beers listing renders and exposes beer filtering", async ({ page }) => {
  await page.goto("/beers");
  await expect(
    page.getByRole("heading", { name: "Our Beers" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Flagship Styles" })
  ).toBeVisible();
  // Filter controls render regardless of whether beer data loaded.
  await expect(page.getByRole("button", { name: "All" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Core" })).toBeVisible();
});

test("beer detail route renders a clean not-found page for an unknown slug", async ({
  page,
}) => {
  // The slug is intentionally absent so the result is identical whether the
  // Firestore-backed catalog is populated or empty.
  const response = await page.goto("/beers/definitely-not-a-real-beer");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not be found|404/i).first()).toBeVisible();
});

test("about page renders long-form MDX content", async ({ page }) => {
  await page.goto("/about");
  await expect(
    page.getByRole("heading", { name: /about deep dive/i })
  ).toBeVisible();
  await expect(page.getByText(/saba/i).first()).toBeVisible();
});

test("trade page renders the inquiry form", async ({ page }) => {
  await page.goto("/trade");
  // Canonical page assertions — the h1 and "What to expect" section exist only
  // in page.tsx, so this fails if the old tabled MDX stub ever returns.
  await expect(
    page.getByRole("heading", { name: "Trade & Wholesale", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What to expect" })
  ).toBeVisible();
  await expect(page.getByLabel("Business name")).toBeVisible();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Message (optional)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send inquiry" })
  ).toBeEnabled();
  // Client-side interactivity works without touching the real API.
  const businessName = page.getByLabel("Business name");
  await businessName.fill("Smoke Test Tavern");
  await expect(businessName).toHaveValue("Smoke Test Tavern");
});

test("contact page renders contact actions", async ({ page }) => {
  await page.goto("/contact");
  await expect(
    page.getByRole("heading", { name: /contact us/i })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "WhatsApp", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /\+599-416-3544/ })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /info@deepdivebrewing\.com/i })
  ).toBeVisible();
});

test("contact page has no horizontal overflow and keeps content visible at small widths", async ({
  page,
}) => {
  // Representative narrow mobile and tablet widths — the layout must never
  // force horizontal scrolling or hide the primary contact actions.
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/contact");

    const scrollOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(scrollOverflow).toBeLessThanOrEqual(0);

    await expect(
      page.getByRole("link", { name: /\+599-416-3544/ })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /info@deepdivebrewing\.com/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Get directions" })
    ).toBeVisible();
    await expect(page.getByText("66 Fort Bay Road").first()).toBeVisible();
    await expect(
      page.getByText(/Monday to Friday, 8:00 AM to 3:00 PM/)
    ).toBeVisible();
  }
});

test("contact email stays on one line at supported mobile widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/contact");

  const email = page.getByRole("link", {
    name: /info@deepdivebrewing\.com/i,
  });
  await expect(email).toBeVisible();

  // The link carries a 44px touch target; a mid-address wrap would push the
  // box well past a single line's height.
  const box = await email.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(48);
});

test("contact page presents both brewery tour options with pricing", async ({
  page,
}) => {
  await page.goto("/contact");
  const tours = page.getByRole("region", { name: "Brewery Tours" });
  await expect(tours).toBeVisible();

  // $20 tour — no tasting; $40 tour — total price with tasting included.
  const tour = tours.getByRole("heading", { name: "Brewery Tour", exact: true });
  const tasting = tours.getByRole("heading", { name: "Brewery Tour + Tasting" });
  await expect(tour).toBeVisible();
  await expect(tasting).toBeVisible();
  await expect(tours.getByText("$20")).toBeVisible();
  await expect(tours.getByText("$40")).toBeVisible();
  await expect(
    tours.getByText(/no beer or tasting included/i)
  ).toBeVisible();
  await expect(
    tours.getByText(/generous beer tastings included/i)
  ).toBeVisible();
  await expect(tours.getByText(/~30 minutes/i)).toBeVisible();
  await expect(tours.getByText(/~60 minutes total/i)).toBeVisible();

  // Both CTAs open the tour inquiry modal (Issue #102) — the WhatsApp
  // handoff happens on Continue inside the dialog; the completed message
  // is covered end-to-end in tour-inquiry.spec.ts.
  for (const name of ["Arrange a brewery tour", "Arrange tour + tasting"]) {
    await expect(tours.getByRole("button", { name })).toBeVisible();
  }
});

test("where-to-buy page renders", async ({ page }) => {
  await page.goto("/where-to-buy");
  await expect(
    page.getByRole("heading", { name: "Where to Buy", exact: true })
  ).toBeVisible();
  await expect(page.getByText(/sint maarten|sxm/i).first()).toBeVisible();
});

test("admin renders the sign-in shell without credentials", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Admin Dashboard" })
  ).toBeVisible();
  // The shell renders one of two healthy states: the Google sign-in control
  // when Firebase is configured (local dev with env), or the explicit
  // unavailable fallback in CI where no config exists. What must never
  // appear is a crash page.
  const signInButton = page.getByRole("button", {
    name: /sign in with google/i,
  });
  const unavailableMessage = page.getByText(
    "Sign-in is currently unavailable."
  );
  await expect(signInButton.or(unavailableMessage).first()).toBeVisible();
});
