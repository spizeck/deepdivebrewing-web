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
  // /trade has both page.tsx and page.mdx; which one serves the route differs
  // by platform (Linux/CI resolves the MDX). "Get in Touch" is the heading and
  // TradeInquiryForm the component that both variants share.
  await expect(
    page.getByRole("heading", { name: "Get in Touch" })
  ).toBeVisible();
  await expect(page.getByLabel("Business Name")).toBeVisible();
  await expect(page.getByLabel("Contact Name")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Message")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit Inquiry" })
  ).toBeEnabled();
  // Client-side interactivity works without touching the real API.
  const businessName = page.getByLabel("Business Name");
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
