/**
 * Marketing analytics (GA4 via gtag). Non-PII only — never send email
 * addresses, names, phone numbers, form contents, UIDs, or tokens.
 * See docs/operations/analytics.md for the canonical event taxonomy.
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

type GtagFn = (...args: unknown[]) => void;

function getGtag(): GtagFn | undefined {
  if (typeof window === "undefined") return undefined;
  const gtag = (window as Window & { gtag?: GtagFn }).gtag;
  return typeof gtag === "function" ? gtag : undefined;
}

/**
 * Safely emit a GA4 / gtag event. Non-PII only.
 * No-ops when gtag is unavailable (SSR, previews, localhost, ad-blockers,
 * or consent-mode denial) — analytics must never break site behavior.
 */
export function trackEvent(
  eventName: AnalyticsEventName,
  params: AnalyticsEventParams = {}
): void {
  const gtag = getGtag();
  if (!gtag) return;

  try {
    gtag("event", eventName, params);
  } catch {
    // Ignore analytics failures so they never break site functionality.
  }
}

/**
 * Emit a GA4 page_view for an App Router client-side navigation.
 * The landing page view is sent by `gtag('config', …)` itself; this helper
 * exists because gtag does not observe Next.js route transitions on its own.
 */
export function sendPageView(path: string): void {
  const gtag = getGtag();
  if (!gtag) return;

  try {
    gtag("event", "page_view", { page_path: path });
  } catch {
    // Observational only — never throw.
  }
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
