import { test, expect } from "./fixtures";
import { AxeBuilder } from "@axe-core/playwright";

// Tour inquiry modal (Issue #102): the /contact tour CTAs open a dialog that
// collects a preferred date and party size, then hands off to WhatsApp with
// a completed message. The shared fixture pre-seeds a declined analytics
// consent, so every flow below also proves the handoff works without
// marketing consent; `tour_inquiry_click` still buffers to window.dataLayer.

type DataLayerEntry = Record<string, unknown>;

const getDataLayer = async (
  page: import("playwright").Page
): Promise<DataLayerEntry[]> =>
  page.evaluate(
    () =>
      (window as unknown as { dataLayer?: DataLayerEntry[] }).dataLayer ?? []
  );

const inquiryEvents = (entries: DataLayerEntry[]) =>
  entries.filter((e) => e.event === "tour_inquiry_click");

// An ISO date safely in the future for the date input (YYYY-MM-DD).
function futureDateIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The message formats "October 12" without a year in the current calendar
// year and "January 3, 2027" once the date crosses into the next.
function expectedDateLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(year !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

test("Brewery Tour CTA opens the inquiry modal", async ({ page }) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();

  const dialog = page.getByRole("dialog", { name: "Brewery Tour" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("$20 per person · About 30 minutes")
  ).toBeVisible();
  await expect(dialog.getByText(/tours are by request/i)).toBeVisible();
  await expect(dialog.getByLabel("Preferred date")).toBeVisible();
  await expect(dialog.getByLabel("Party size")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Continue to WhatsApp" })
  ).toBeVisible();
});

test("Brewery Tour + Tasting CTA opens the modal with its product", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange tour + tasting" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Brewery Tour + Tasting",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("$40 per person · About 60 minutes")
  ).toBeVisible();
});

test("Continue is blocked until date and party size are valid", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Brewery Tour" });
  const continueButton = dialog.getByRole("button", {
    name: "Continue to WhatsApp",
  });

  // Empty form: stays open, both errors announced, no popup.
  await continueButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/choose a preferred date/i)).toBeVisible();
  await expect(dialog.getByText(/enter your party size/i)).toBeVisible();
  expect(inquiryEvents(await getDataLayer(page))).toHaveLength(0);

  // Only one field valid: still blocked.
  await dialog.getByLabel("Party size").fill("0");
  await continueButton.click();
  await expect(
    dialog.getByText(/whole number of at least 1/i)
  ).toBeVisible();
});

test("a valid inquiry hands off to WhatsApp with the completed message", async ({
  page,
}) => {
  await page.goto("/contact");
  const cases = [
    {
      cta: "Arrange a brewery tour",
      dialogName: "Brewery Tour",
      partySize: "2",
      expected: (date: string) =>
        `Hi Deep Dive! I'm interested in the $20 Brewery Tour for 2 people on ${expectedDateLabel(date)}. Is that available?`,
    },
    {
      cta: "Arrange tour + tasting",
      dialogName: "Brewery Tour + Tasting",
      partySize: "4",
      expected: (date: string) =>
        `Hi Deep Dive! I'm interested in the $40 Brewery Tour + Tasting for 4 people on ${expectedDateLabel(date)}. Is that available?`,
    },
  ];

  for (const { cta, dialogName, partySize, expected } of cases) {
    await page.getByRole("button", { name: cta }).click();
    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(dialog).toBeVisible();
    const date = futureDateIso();
    await dialog.getByLabel("Preferred date").fill(date);
    await dialog.getByLabel("Party size").fill(partySize);

    // The popup's wa.me navigation is aborted by the fixture's cross-origin
    // isolation — capture the outbound request instead of the popup's URL,
    // which can settle on an error page before it is read.
    const [request] = await Promise.all([
      page
        .context()
        .waitForEvent("request", (r) =>
          r.url().startsWith("https://wa.me/")
        ),
      dialog
        .getByRole("button", { name: "Continue to WhatsApp" })
        .click(),
    ]);
    const url = new URL(request.url());
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://wa.me/5994163544"
    );
    expect(url.searchParams.get("text")).toBe(expected(date));
    await expect(dialog).toBeHidden();
  }

  // Two completed handoffs, one event each, correct labels.
  const inquiries = inquiryEvents(await getDataLayer(page));
  expect(inquiries).toHaveLength(2);
  expect(inquiries[0]).toMatchObject({
    event_category: "conversion",
    cta_location: "contact_page_tours",
    event_label: "Brewery Tour",
  });
  expect(inquiries[1]).toMatchObject({
    event_category: "conversion",
    cta_location: "contact_page_tours",
    event_label: "Brewery Tour + Tasting",
  });
});

test("opening and abandoning the modal fires no inquiry event", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  await expect(
    page.getByRole("dialog", { name: "Brewery Tour" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(inquiryEvents(await getDataLayer(page))).toHaveLength(0);
});

test("Escape closes the dialog and returns focus to the CTA", async ({
  page,
}) => {
  await page.goto("/contact");
  const cta = page.getByRole("button", { name: "Arrange a brewery tour" });
  await cta.click();
  await expect(
    page.getByRole("dialog", { name: "Brewery Tour" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Brewery Tour" })
  ).toBeHidden();
  await expect(cta).toBeFocused();
});

test("the close button closes the dialog and returns focus", async ({
  page,
}) => {
  await page.goto("/contact");
  const cta = page.getByRole("button", { name: "Arrange tour + tasting" });
  await cta.click();
  const dialog = page.getByRole("dialog", {
    name: "Brewery Tour + Tasting",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(cta).toBeFocused();
});

test("reopening for the other product shows it with a fresh form", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const tourDialog = page.getByRole("dialog", { name: "Brewery Tour" });
  await tourDialog.getByLabel("Preferred date").fill(futureDateIso());
  await tourDialog.getByLabel("Party size").fill("3");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Arrange tour + tasting" }).click();
  const tastingDialog = page.getByRole("dialog", {
    name: "Brewery Tour + Tasting",
  });
  await expect(tastingDialog).toBeVisible();
  await expect(tastingDialog.getByLabel("Preferred date")).toHaveValue("");
  await expect(tastingDialog.getByLabel("Party size")).toHaveValue("");
});

test("the open dialog has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  await expect(
    page.getByRole("dialog", { name: "Brewery Tour" })
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? "")
  );
  expect(violations).toEqual([]);
});

for (const width of [320, 375]) {
  test(`no horizontal overflow at ${width}px with the dialog open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/contact");
    await page
      .getByRole("button", { name: "Arrange a brewery tour" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Brewery Tour" })
    ).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflows).toBe(false);
  });
}
