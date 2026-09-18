/**
 * Marketing analytics (GA4 delivered via Google Tag Manager). The app pushes
 * structured events to `window.dataLayer`; GTM forwards them to GA4. Non-PII
 * only — never send email addresses, names, phone numbers, form contents,
 * UIDs, or tokens. See docs/operations/analytics.md for the canonical event
 * taxonomy and the GTM-side tag/trigger configuration.
 */
export type AnalyticsEventName =
  | "where_to_buy_click"
  | "retailer_click"
  | "directions_click"
  | "whatsapp_click"
  | "email_click"
  | "social_click"
  | "tour_inquiry_click"
  | "beer_detail_view"
  | "beer_filter"
  | "trade_form_start"
  | "trade_form_success"
  | "trade_form_error";

export interface AnalyticsEventParams
  extends Record<string, string | number | undefined> {
  event_category?: string;
  event_label?: string;
  cta_location?: string;
  beer_slug?: string;
  beer_name?: string;
  beer_style?: string;
  beer_status?: string;
  venue_slug?: string;
  island?: string;
  venue_type?: string;
  social_network?: string;
  filter?: string;
}

type DataLayerEntry = Record<string, unknown>;

// Admin activity belongs to the application audit logs, not marketing
// analytics. This boundary lives in the push helper itself so no caller —
// click tracker, page-view tracker, or any future one — can leak events on
// /admin or /admin-fixture, even when a GTM container was loaded earlier in
// the session. Note this only gates the application's own events: a loaded
// container's own automatic collection survives until the document that
// loaded it is gone, which AdminAnalyticsGuard enforces by forcing a full
// document load on entry to /admin*.
function isAdminPath(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location?.pathname?.startsWith("/admin") === true
  );
}

/**
 * Return the live dataLayer array, creating it if needed. The queue exists
 * independently of GTM: pushes made before gtm.js loads (or when it never
 * loads — ad-blockers, non-production builds) are simply buffered/ignored.
 */
function getDataLayer(): DataLayerEntry[] | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as Window & { dataLayer?: DataLayerEntry[] };
  w.dataLayer = w.dataLayer ?? [];
  return w.dataLayer;
}

/**
 * True when this document is carrying a Google Tag Manager container — the
 * `google_tag_manager` runtime or at least the `gtm.start` bootstrap entry
 * it pushes into the queue. A dataLayer created by `pushToDataLayer` alone
 * is not proof: it exists for pushes even when GTM is absent (previews,
 * dev, ad-blockers).
 */
export function documentHasMarketingContainer(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    google_tag_manager?: unknown;
    dataLayer?: DataLayerEntry[];
  };
  if (w.google_tag_manager != null) return true;
  return (w.dataLayer ?? []).some(
    (entry) => entry != null && "gtm.start" in entry
  );
}

function pushToDataLayer(entry: DataLayerEntry): void {
  if (isAdminPath()) return;
  try {
    getDataLayer()?.push(entry);
  } catch {
    // Ignore analytics failures so they never break site functionality.
  }
}

/**
 * Emit a canonical business event to the dataLayer.
 * Shape consumed by GTM Custom Event triggers:
 *   { event: "trade_form_success", venue_type: "bar", cta_location: "trade_page" }
 * Non-PII only — the param vocabulary below is the boundary.
 */
export function trackEvent(
  eventName: AnalyticsEventName,
  params: AnalyticsEventParams = {}
): void {
  pushToDataLayer({ event: eventName, ...params });
}

/**
 * Emit a page_view event. The application owns ALL page_view generation —
 * the initial landing view and every App Router client navigation — and the
 * GTM Google tag is configured with send_page_view=false, so nothing else
 * emits page views and duplication is impossible by construction.
 */
export function sendPageView(path: string): void {
  pushToDataLayer({ event: "page_view", page_path: path });
}

/**
 * Map `data-analytics-*` dataset attributes to event params.
 * camelCase dataset keys become snake_case GA4 params; only keys in
 * DATA_PARAM_KEYS are collected, so arbitrary attributes can't leak in.
 */
export const DATA_PARAM_KEYS = [
  "eventCategory",
  "eventLabel",
  "ctaLocation",
  "beerSlug",
  "beerName",
  "beerStyle",
  "beerStatus",
  "venueSlug",
  "island",
  "venueType",
  "socialNetwork",
  "filter",
] as const;

function toSnakeCase(input: string): string {
  return input.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function collectAnalyticsParams(
  dataset: DOMStringMap | Record<string, string | undefined>
): AnalyticsEventParams {
  const params: AnalyticsEventParams = {};
  for (const key of DATA_PARAM_KEYS) {
    const value = dataset[`analytics${key.charAt(0).toUpperCase()}${key.slice(1)}`];
    if (value !== undefined) {
      params[toSnakeCase(key)] = value;
    }
  }
  return params;
}
