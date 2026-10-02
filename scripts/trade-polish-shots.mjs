// Temporary visual-inspection script for the /admin/trade polish pass.
// Serves fixture data via route mocks and screenshots the workspace at
// several viewports. Run with a `next start` server that has
// ADMIN_A11Y_FIXTURE=1 (BASE_URL env to override the default port).
import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "screenshots", "trade-polish");
await mkdir(outDir, { recursive: true });

const baseUrl = process.env.BASE_URL ?? "http://localhost:3105";

const lead = (over) => ({
  venueType: "bar",
  status: "new",
  source: "trade_form",
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
  lastActivityAt: "2026-10-02T12:00:00.000Z",
  ...over,
});

// "Today" shifts with the clock; anchor relative dates to now so the
// overdue/due-today/upcoming pills are exercised regardless of run date.
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 864e5).toISOString();

const LEADS = [
  lead({
    id: "lead-1",
    businessName: "Fixture Harbour Bar",
    contactName: "Sam Keeper",
    email: "sam@harbour.example",
    phoneOrWhatsapp: "+599 555 1234",
    message:
      "Interested in carrying the Pilsner on tap. We have two lines free from next month and a fridge for cans. Can someone drop by with samples and the wholesale price list?",
    status: "contacted",
    assignedToName: "Chad",
    assignedToUid: "u-1",
    nextFollowUpAt: daysAgo(2),
  }),
  lead({
    id: "lead-2",
    businessName: "Saba Bottleshop",
    contactName: "Maya Reyes",
    email: "maya@bottleshop.example",
    venueType: "retail",
    status: "follow_up",
    nextFollowUpAt: daysAgo(0),
  }),
  lead({
    id: "lead-3",
    businessName: "Windward Restaurant & Grill House",
    contactName: "Tom",
    venueType: "restaurant",
    status: "new",
    nextFollowUpAt: daysAhead(5),
    createdAt: daysAgo(1),
    lastActivityAt: daysAgo(1),
    updatedAt: daysAgo(1),
  }),
  lead({
    id: "lead-4",
    businessName: "Hilltop Hotel",
    contactName: "Ana",
    venueType: "hotel",
    status: "customer",
    source: "whatsapp",
    assignedToName: "Chad",
    assignedToUid: "u-1",
    outcome: "First order placed",
    closedAt: daysAgo(3),
    createdAt: daysAgo(30),
    lastActivityAt: daysAgo(3),
    updatedAt: daysAgo(3),
  }),
  lead({
    id: "lead-5",
    businessName: "Island Dive Shop",
    venueType: "other",
    status: "closed",
    source: "in_person",
    closedAt: daysAgo(10),
    createdAt: daysAgo(40),
    lastActivityAt: daysAgo(10),
    updatedAt: daysAgo(10),
  }),
];

const ACTIVITIES = [
  {
    id: "a-0",
    type: "lead_created",
    seq: 0,
    details: { source: "trade_form" },
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  {
    id: "a-1",
    type: "owner_changed",
    seq: 1,
    authorUid: "u-1",
    authorName: "Chad",
    details: { fromName: null, toName: "Chad" },
    createdAt: "2026-10-01T13:00:00.000Z",
  },
  {
    id: "a-2",
    type: "status_changed",
    seq: 2,
    authorUid: "u-1",
    authorName: "Chad",
    details: { from: "new", to: "contacted" },
    createdAt: "2026-10-02T09:00:00.000Z",
  },
  {
    id: "a-3",
    type: "note",
    seq: 3,
    authorUid: "u-1",
    authorName: "Chad",
    body: "Spoke on WhatsApp. Interested in the Pilsner — wants samples first.",
    createdAt: "2026-10-02T10:00:00.000Z",
  },
  {
    id: "a-4",
    type: "follow_up_set",
    seq: 4,
    authorUid: "u-1",
    authorName: "Chad",
    details: { to: daysAgo(2) },
    createdAt: "2026-10-02T10:05:00.000Z",
  },
];

const mockApi = async (page) => {
  await page.route(/\/api\/admin\/trade-leads/, (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (method === "GET" && url.endsWith("/api/admin/trade-leads")) {
      return json({
        ok: true,
        leads: LEADS,
        admins: [
          { uid: "u-1", name: "Chad" },
          { uid: "u-2", name: "Malachy" },
        ],
      });
    }
    if (method === "GET" && url.includes("/api/admin/trade-leads/")) {
      const id = url.split("/api/admin/trade-leads/")[1].split("?")[0];
      const found = LEADS.find((l) => l.id === id);
      return json({ ok: true, lead: found, activities: ACTIVITIES });
    }
    if (method === "PATCH" || method === "POST") {
      return json({ ok: true, lead: LEADS[0], activities: ACTIVITIES });
    }
    return json({ ok: false, error: "Unexpected fixture request" });
  });
};

const viewports = [
  { width: 1440, height: 900, name: "desktop-1440" },
  { width: 1024, height: 768, name: "laptop-1024" },
  { width: 820, height: 1000, name: "tablet-820" },
  { width: 390, height: 844, name: "mobile-390" },
];

const browser = await chromium.launch({ headless: true });

for (const vp of viewports) {
  const context = await browser.newContext({ viewport: vp });
  const p = await context.newPage();
  await mockApi(p);
  try {
    await p.goto(`${baseUrl}/admin-trade-fixture`, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    await p.getByText("Fixture Harbour Bar").first().waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({
      path: join(outDir, `list-${vp.name}.png`),
      fullPage: true,
    });
    await p
      .getByRole("button", { name: /Fixture Harbour Bar/ })
      .press("Enter");
    await p.getByText("Spoke on WhatsApp").waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({
      path: join(outDir, `detail-${vp.name}.png`),
      fullPage: true,
    });
    console.log(`done ${vp.name}`);
  } catch (err) {
    console.error(`Failed @ ${vp.name}: ${err.message}`);
  } finally {
    await context.close();
  }
}

await browser.close();
