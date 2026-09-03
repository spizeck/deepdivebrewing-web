export type AnalyticsEventName =
  | "where_to_buy_click"
  | "directions_click"
  | "whatsapp_click"
  | "beer_detail_view"
  | "trade_form_start"
  | "trade_form_success"
  | "trade_form_error"
  | "tour_inquiry_click";

export interface AnalyticsEventParams extends Record<string, string | number | undefined> {
  event_category?: string;
  event_label?: string;
  beer_slug?: string;
  beer_name?: string;
  beer_style?: string;
  partner_name?: string;
  island?: string;
  cta_location?: string;
  venue_type?: string;
}

/**
 * Safely emit a GA4 / gtag event. Non-PII only.
 * Falls back silently if gtag is unavailable or blocked by consent / ad-blockers.
 */
export function trackEvent(
  eventName: AnalyticsEventName,
  params: AnalyticsEventParams = {}
): void {
  if (typeof window === "undefined") return;

  const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
  if (typeof gtag !== "function") return;

  try {
    gtag("event", eventName, params);
  } catch {
    // Ignore analytics failures so they never break site functionality.
  }
}
