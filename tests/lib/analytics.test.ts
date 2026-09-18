import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  trackEvent,
  sendPageView,
  collectAnalyticsParams,
  documentHasMarketingContainer,
  type AnalyticsEventName,
} from "../../lib/analytics";

type DataLayerEntry = Record<string, unknown>;

function stubWindow(
  overrides: Record<string, unknown> = {}
): { dataLayer: () => DataLayerEntry[] | undefined } {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    location: { pathname: "/", search: "" },
    ...overrides,
  };
  return {
    dataLayer: () =>
      (g.window as { dataLayer?: DataLayerEntry[] }).dataLayer,
  };
}

afterEach(() => {
  // Ensure no window stub leaks between tests.
  delete (globalThis as Record<string, unknown>).window;
});

describe("trackEvent", () => {
  it("no-ops harmlessly in SSR (no window)", () => {
    assert.doesNotThrow(() => trackEvent("whatsapp_click", { island: "saba" }));
  });

  it("creates window.dataLayer and pushes { event, ...params }", () => {
    const { dataLayer } = stubWindow();
    trackEvent("retailer_click", {
      venue_slug: "harbour-view",
      island: "saba",
      venue_type: "bar",
    });
    assert.deepEqual(dataLayer(), [
      {
        event: "retailer_click",
        venue_slug: "harbour-view",
        island: "saba",
        venue_type: "bar",
      },
    ]);
  });

  it("appends to an existing dataLayer (e.g. created by the GTM snippet)", () => {
    const existing: DataLayerEntry[] = [{ "gtm.start": 1, event: "gtm.js" }];
    const { dataLayer } = stubWindow({ dataLayer: existing });
    trackEvent("email_click");
    assert.equal(dataLayer(), existing);
    assert.deepEqual(dataLayer()![1], { event: "email_click" });
  });

  it("never throws even when dataLayer.push throws", () => {
    const hostile: DataLayerEntry[] = [];
    hostile.push = () => {
      throw new Error("dataLayer exploded");
    };
    stubWindow({ dataLayer: hostile });
    assert.doesNotThrow(() => trackEvent("trade_form_success"));
  });
});

describe("sendPageView", () => {
  it("pushes a page_view event with page_path", () => {
    const { dataLayer } = stubWindow();
    sendPageView("/beers?x=1");
    assert.deepEqual(dataLayer(), [
      { event: "page_view", page_path: "/beers?x=1" },
    ]);
  });
});

describe("admin exclusion", () => {
  it("pushes nothing on /admin — the queue is never even created", () => {
    const { dataLayer } = stubWindow({
      location: { pathname: "/admin", search: "" },
    });
    sendPageView("/admin");
    trackEvent("email_click");
    assert.equal(dataLayer(), undefined);
  });

  it("pushes nothing on /admin-fixture", () => {
    const { dataLayer } = stubWindow({
      location: { pathname: "/admin-fixture", search: "" },
    });
    sendPageView("/admin-fixture");
    trackEvent("beer_filter", { filter: "core" });
    assert.equal(dataLayer(), undefined);
  });
});

describe("documentHasMarketingContainer", () => {
  it("is false in SSR (no window)", () => {
    assert.equal(documentHasMarketingContainer(), false);
  });

  it("is false when only the app-created dataLayer exists", () => {
    // pushToDataLayer creates the queue without GTM — that must not count
    // as a live container or AdminAnalyticsGuard would reload-loop.
    stubWindow({ dataLayer: [{ event: "page_view", page_path: "/" }] });
    assert.equal(documentHasMarketingContainer(), false);
  });

  it("is false with no dataLayer at all", () => {
    stubWindow();
    assert.equal(documentHasMarketingContainer(), false);
  });

  it("is true when the gtm.start bootstrap entry is present", () => {
    stubWindow({ dataLayer: [{ "gtm.start": 1, event: "gtm.js" }] });
    assert.equal(documentHasMarketingContainer(), true);
  });

  it("is true when the google_tag_manager runtime exists", () => {
    stubWindow({ google_tag_manager: {} });
    assert.equal(documentHasMarketingContainer(), true);
  });
});

describe("collectAnalyticsParams", () => {
  it("maps whitelisted data-analytics-* keys to snake_case params", () => {
    const params = collectAnalyticsParams({
      analyticsEventCategory: "conversion",
      analyticsCtaLocation: "homepage_hero",
      analyticsVenueSlug: "harbour-view",
      analyticsSocialNetwork: "instagram",
    });
    assert.deepEqual(params, {
      event_category: "conversion",
      cta_location: "homepage_hero",
      venue_slug: "harbour-view",
      social_network: "instagram",
    });
  });

  it("drops unknown dataset keys so arbitrary attributes cannot leak in", () => {
    const params = collectAnalyticsParams({
      analyticsVenueSlug: "x",
      analyticsEmail: "person@example.com", // not a whitelisted key
      otherThing: "y",
    });
    assert.deepEqual(params, { venue_slug: "x" });
  });

  it("ignores whitelisted keys that are absent", () => {
    const params = collectAnalyticsParams({});
    assert.deepEqual(params, {});
  });
});

describe("taxonomy", () => {
  it("event names are stable snake_case", () => {
    // Compile-time union enforced by TS; runtime sanity check on known values.
    const names: AnalyticsEventName[] = [
      "where_to_buy_click",
      "retailer_click",
      "directions_click",
      "whatsapp_click",
      "email_click",
      "social_click",
      "tour_inquiry_click",
      "beer_detail_view",
      "beer_filter",
      "trade_form_start",
      "trade_form_success",
      "trade_form_error",
    ];
    for (const name of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
    }
  });
});
