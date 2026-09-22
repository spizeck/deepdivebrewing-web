import { test, expect } from "./fixtures";
import { AxeBuilder } from "@axe-core/playwright";

// Tour inquiry modal (Issue #102): the /contact tour CTAs open a dialog that
// collects a preferred date and party size, then hands off to WhatsApp with
// a completed message. The shared fixture pre-seeds a declined analytics
// consent, so every flow below also proves the handoff works without
// marketing consent; `tour_inquiry_click` still buffers to window.dataLayer.
//
// The date field is a custom calendar picker: native `input[type=date]`
// lets users type past dates past `min` on every engine (verified), and
// non-Chromium pickers do not reliably disable them either.

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

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Full "October 12, 2026" — the day buttons' accessible names.
const longLabel = (d: Date) =>
  d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

// The WhatsApp message format: "October 12" same-year, "October 12, 2027"
// once the date crosses into a different calendar year.
function expectedDateLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(year !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

// Opens the picker and selects the local calendar date `daysAhead` from
// today. Returns its ISO value.
async function pickDate(
  page: import("playwright").Page,
  daysAhead: number
): Promise<string> {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  await page.getByLabel("Preferred date").click();
  const now = new Date();
  let monthsAhead =
    (target.getFullYear() - now.getFullYear()) * 12 +
    (target.getMonth() - now.getMonth());
  const nextMonth = page.getByRole("button", { name: "Next month" });
  while (monthsAhead-- > 0) await nextMonth.click();
  await page
    .getByRole("button", { name: longLabel(target), exact: true })
    .click();
  return isoOf(target);
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

test("the picker disables every day before the visitor's local today", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Brewery Tour" });
  const field = dialog.getByLabel("Preferred date");
  await field.click();

  // The picker opens on the visitor's local current month; earlier months
  // are unreachable.
  await expect(
    dialog.getByRole("button", { name: "Previous month" })
  ).toBeDisabled();

  const todayIso = isoOf(new Date());
  for (const day of await dialog
    .getByRole("gridcell")
    .getByRole("button")
    .all()) {
    const iso = await day.getAttribute("data-date");
    await expect(day).toHaveAttribute(
      "aria-disabled",
      String(iso! < todayIso)
    );
  }

  // Today is enabled and marked as the current date.
  const today = dialog.getByRole("button", {
    name: longLabel(new Date()),
    exact: true,
  });
  await expect(today).toHaveAttribute("aria-disabled", "false");
  await expect(today).toHaveAttribute("aria-current", "date");
});

test("a past day cannot be selected or submitted", async ({ page }) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Brewery Tour" });
  const field = dialog.getByLabel("Preferred date");
  await field.click();

  // Yesterday is visible in this month's grid unless today is the 1st.
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.getMonth() === now.getMonth()) {
    const yesterdayButton = dialog.getByRole("button", {
      name: longLabel(yesterday),
      exact: true,
    });
    await expect(yesterdayButton).toHaveAttribute("aria-disabled", "true");
    // Dispatch the click anyway — the component's own guard must refuse it
    // (aria-disabled elements are not actionable for real pointer input).
    await yesterdayButton.dispatchEvent("click");
    // Selection refused — the field still shows the empty state.
    await expect(field).toHaveText(/select a date/i);
  }

  // Close the picker and try to continue with the date still unset.
  await page.keyboard.press("Escape");
  await dialog.getByLabel("Party size").fill("2");
  await dialog.getByRole("button", { name: "Continue to WhatsApp" }).click();
  await expect(dialog.getByText(/choose a preferred date/i)).toBeVisible();
  expect(inquiryEvents(await getDataLayer(page))).toHaveLength(0);
});

test("today is selectable and produces a same-day inquiry", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Brewery Tour" });

  const iso = await pickDate(page, 0);
  await expect(dialog.getByLabel("Preferred date")).toContainText(
    longLabel(new Date())
  );
  await dialog.getByLabel("Party size").fill("2");

  const [request] = await Promise.all([
    page
      .context()
      .waitForEvent("request", (r) => r.url().startsWith("https://wa.me/")),
    dialog.getByRole("button", { name: "Continue to WhatsApp" }).click(),
  ]);
  const url = new URL(request.url());
  expect(url.searchParams.get("text")).toBe(
    `Hi Deep Dive! I'm interested in the $20 Brewery Tour for 2 people on ${expectedDateLabel(iso)}. Is that available?`
  );
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
  await pickDate(page, 30);
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
    const iso = await pickDate(page, 30);
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
    expect(url.searchParams.get("text")).toBe(expected(iso));
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

test("arrow keys move focus between days in the picker", async ({ page }) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const field = page.getByLabel("Preferred date");
  await field.click();

  // Focus starts on today; one week ahead lands on the matching day even if
  // that crosses into the next month's grid.
  const inAWeek = new Date();
  inAWeek.setDate(inAWeek.getDate() + 7);
  await page.keyboard.press("ArrowDown");
  const focused = page.locator("[role=gridcell] button:focus");
  await expect(focused).toHaveAttribute("data-date", isoOf(inAWeek));

  // Enter selects the focused day.
  await page.keyboard.press("Enter");
  await expect(field).toContainText(longLabel(inAWeek));
});

test("reopening for the other product shows it with a fresh form", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const tourDialog = page.getByRole("dialog", { name: "Brewery Tour" });
  await pickDate(page, 14);
  await tourDialog.getByLabel("Party size").fill("3");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Arrange tour + tasting" }).click();
  const tastingDialog = page.getByRole("dialog", {
    name: "Brewery Tour + Tasting",
  });
  await expect(tastingDialog).toBeVisible();
  await expect(tastingDialog.getByLabel("Preferred date")).toContainText(
    /select a date/i
  );
  await expect(tastingDialog.getByLabel("Party size")).toHaveValue("");
});

test("the open dialog has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Brewery Tour" });
  await expect(dialog).toBeVisible();
  // Also scan with the calendar popover open — it is the interactive surface
  // where the picker accessibility actually lives.
  await dialog.getByLabel("Preferred date").click();
  await expect(dialog.getByRole("grid")).toBeVisible();
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
    const dialog = page.getByRole("dialog", { name: "Brewery Tour" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Preferred date").click();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflows).toBe(false);
  });
}
