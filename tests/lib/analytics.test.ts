import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  trackEvent,
  sendPageView,
  collectAnalyticsParams,
  type AnalyticsEventName,
} from "../../lib/analytics";

type GtagCall = unknown[];

function stubGtag(): { calls: GtagCall[]; restore: () => void } {
  const calls: GtagCall[] = [];
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  g.window = { gtag: (...args: unknown[]) => calls.push(args) };
  return {
    calls,
    restore: () => {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    },
  };
}

function stubThrowingGtag(): { restore: () => void } {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  g.window = {
    gtag: () => {
      throw new Error("gtag exploded");
    },
  };
  return {
    restore: () => {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    },
  };
}

afterEach(() => {
  // Ensure no window stub leaks between tests.
  delete (globalThis as Record<string, unknown>).window;
});

describe("trackEvent", () => {
  it("no-ops harmlessly when window/gtag is unavailable (SSR, previews, blockers)", () => {
    // In the node test environment `window` is undefined.
    assert.doesNotThrow(() => trackEvent("whatsapp_click", { island: "saba" }));
  });

  it("no-ops when window exists but gtag is not a function", () => {
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    assert.doesNotThrow(() => trackEvent("email_click"));
  });

  it("dispatches the event name and params through gtag", () => {
    const { calls } = stubGtag();
    trackEvent("retailer_click", {
      venue_slug: "harbour-view",
      island: "saba",
      venue_type: "bar",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "event",
      "retailer_click",
      { venue_slug: "harbour-view", island: "saba", venue_type: "bar" },
    ]);
  });

  it("never throws even when gtag itself throws", () => {
    stubThrowingGtag();
    assert.doesNotThrow(() => trackEvent("trade_form_success"));
  });
});

describe("sendPageView", () => {
  it("emits a page_view event with the path", () => {
    const { calls } = stubGtag();
    sendPageView("/beers?x=1");
    assert.deepEqual(calls, [["event", "page_view", { page_path: "/beers?x=1" }]]);
  });

  it("no-ops without gtag", () => {
    assert.doesNotThrow(() => sendPageView("/beers"));
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
