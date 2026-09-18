import { test, expect } from "./fixtures";

// Consent-layer checks for the production build. The consent manager is
// bundled Klaro (open-source, no vendor service), so the real UI runs
// deterministically in CI with no external dependency. The shared fixture
// seeds a stored "declined" choice; these tests clear cookies first to
// exercise the undecided-visitor notice.
//
// What is NOT exercised here: a live GTM container (test builds serve no
// GTM — see analytics.spec.ts). The observable contract is the dataLayer
// command queue the container would drain: `["consent","update",{…}]`
// entries pushed by the Klaro → Consent Mode bridge.
//
// Selectors mix Klaro's stable class hooks (#klaro-cookie-notice,
// .cm-modal, .cm-list-title) with role/name queries for the action
// labels — the labels are repo-owned config (lib/consent.ts
// translations), so asserting them verifies the DDB copy contract.

type DataLayerEntry = Record<string, unknown> & { 0?: string; 1?: string };

const getDataLayer = async (
  page: import("playwright").Page
): Promise<DataLayerEntry[]> =>
  page.evaluate(
    () =>
      (window as unknown as { dataLayer?: DataLayerEntry[] }).dataLayer ?? []
  );

const consentUpdates = (entries: DataLayerEntry[]) =>
  entries.filter((e) => e[0] === "consent" && e[1] === "update");

const lastConsentUpdate = async (page: import("playwright").Page) => {
  await expect
    .poll(async () => consentUpdates(await getDataLayer(page)).length)
    .toBeGreaterThan(0);
  return consentUpdates(await getDataLayer(page)).at(-1)?.[2] as Record<
    string,
    string
  >;
};

const notice = (page: import("playwright").Page) =>
  page.locator("#klaro-cookie-notice");

const acceptAll = (page: import("playwright").Page) =>
  notice(page).getByRole("button", { name: "Allow analytics" });

const declineAll = (page: import("playwright").Page) =>
  notice(page).getByRole("button", { name: "No thanks" });

const clearStoredConsent = async (page: import("playwright").Page) =>
  page.context().clearCookies();

test("undecided visitor sees accept, decline, and manage options", async ({
  page,
}) => {
  await clearStoredConsent(page);
  await page.goto("/");

  await expect(notice(page)).toBeVisible();
  await expect(
    notice(page).getByText("Cookies. Sadly, not the beer kind.")
  ).toBeVisible();
  await expect(acceptAll(page)).toBeVisible();
  await expect(declineAll(page)).toBeVisible();

  // The manage control opens the full manager with per-service toggles
  // and the modal's own accept/save actions.
  await notice(page)
    .getByRole("link", { name: "Manage preferences" })
    .click();
  const modal = page.locator(".cm-modal");
  await expect(modal).toBeVisible();
  await expect(
    modal.locator(".cm-list-title", { hasText: "Google Analytics" })
  ).toBeVisible();
  await expect(
    modal.getByRole("button", { name: "Allow analytics" })
  ).toBeVisible();
  await expect(
    modal.getByRole("button", { name: "Save preferences" })
  ).toBeVisible();
});

test("declining all keeps analytics_storage denied and closes the notice", async ({
  page,
}) => {
  await clearStoredConsent(page);
  await page.goto("/");

  await declineAll(page).click();
  await expect(notice(page)).toHaveCount(0);

  const update = await lastConsentUpdate(page);
  expect(update).toMatchObject({
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    security_storage: "granted",
  });
});

test("accepting all grants analytics_storage only", async ({ page }) => {
  await clearStoredConsent(page);
  await page.goto("/");

  await acceptAll(page).click();
  await expect(notice(page)).toHaveCount(0);

  const update = await lastConsentUpdate(page);
  expect(update).toMatchObject({
    analytics_storage: "granted",
    // No advertising services exist — these must never flip on.
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
});

test("a stored choice persists across reloads and re-applies consent", async ({
  page,
}) => {
  await clearStoredConsent(page);
  await page.goto("/");
  await acceptAll(page).click();
  await lastConsentUpdate(page);

  // Reload: the stored choice means no notice, and the granted consent is
  // re-published onto the fresh document's dataLayer queue.
  await page.reload();
  await expect(notice(page)).toHaveCount(0);
  const update = await lastConsentUpdate(page);
  expect(update.analytics_storage).toBe("granted");
});

test("preferences reopen via the footer Cookie preferences control", async ({
  page,
}) => {
  // Fixture-seeded consent → no notice; the footer control must still open
  // the manager so the choice can be changed.
  await page.goto("/");
  await expect(notice(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Cookie preferences" }).click();
  await expect(page.locator(".cm-modal")).toBeVisible();
  await expect(
    page.locator(".cm-list-title", { hasText: "Google Analytics" })
  ).toBeVisible();
});

test("/admin serves no consent UI and queues no consent commands", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("#klaro")).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);
  expect(consentUpdates(await getDataLayer(page))).toHaveLength(0);
});
