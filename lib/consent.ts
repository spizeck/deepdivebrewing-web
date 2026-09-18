/**
 * Google Consent Mode v2 defaults + the GTM bootstrap snippet that
 * establishes them. Ordering is the whole point: the `consent` `default`
 * command must sit in `window.dataLayer` BEFORE any GTM/Google tag can
 * evaluate, so it is pushed by the same inline script that pushes
 * `gtm.start` — one script, impossible to race. Cookiebot `uc.js` (loaded
 * separately, afterInteractive) then fires `consent` `update` commands
 * from the visitor's stored choice or banner interaction.
 *
 * The site uses GA4 for analytics only — no advertising tags exist. The
 * `ad_*` signals are still declared because Consent Mode v2 defines them
 * and GA4 reads them; they stay `denied` unless a visitor grants the
 * marketing category.
 *
 * See docs/operations/analytics.md for the full consent architecture and
 * the owner-side Cookiebot/GTM configuration checklist.
 */
export const CONSENT_DEFAULTS = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  functionality_storage: "denied",
  personalization_storage: "denied",
  security_storage: "granted",
  wait_for_update: 500,
} as const;

/**
 * Inline bootstrap that runs before the GTM container script. When a
 * Cookiebot ID is configured the Consent Mode defaults are pushed first
 * (deny-by-default until the CMP grants), then `gtm.start`; without a CMP
 * only `gtm.start` is pushed, preserving the pre-consent-mode behavior of
 * an unconfigured deployment. `window.gtag` is stubbed so both the default
 * push and Cookiebot's later `consent update` calls serialize onto the
 * same dataLayer command queue that gtag.js drains.
 */
export function buildGtmInitScript(cookiebotId?: string): string {
  const consent = cookiebotId
    ? `window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};window.gtag("consent","default",${JSON.stringify(CONSENT_DEFAULTS)});`
    : "";
  return `(window.dataLayer=window.dataLayer||[]);${consent}window.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js'});`;
}
