/**
 * Google Consent Mode v2 defaults, the inline GTM bootstrap that
 * establishes them, and the self-hosted Klaro consent layer that
 * translates visitor choices into `consent` `update` commands.
 *
 * Ordering is the whole point: the `consent` `default` command must sit
 * in `window.dataLayer` BEFORE any GTM/Google tag can evaluate, so it is
 * pushed by the same inline script that pushes `gtm.start` — one script,
 * impossible to race. Klaro (bundled from npm, no hosted CMP service)
 * then fires `consent` `update` commands from the visitor's stored
 * choice or banner interaction.
 *
 * The site uses GA4 for analytics only — no advertising tags exist. The
 * `ad_*` signals are still declared because Consent Mode v2 defines them
 * and GA4 reads them; they stay `denied` because no service grants them.
 *
 * See docs/operations/analytics.md for the full consent architecture and
 * the owner-side GTM configuration checklist.
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

export type ConsentState = "granted" | "denied";

export type ConsentSignal = Exclude<
  keyof typeof CONSENT_DEFAULTS,
  "wait_for_update"
>;

export type ConsentUpdate = Record<ConsentSignal, ConsentState>;

/**
 * Bump when the service registry or categories change materially. The
 * consent cookie name embeds it, so a bump means no stored choice
 * matches and every visitor is asked again — renewed consent, never
 * silently carried forward under an outdated policy.
 */
export const CONSENT_POLICY_VERSION = 1;

export const CONSENT_STORAGE_NAME = `ddb-consent-v${CONSENT_POLICY_VERSION}`;

/**
 * A service in the site's consent registry. Consent-managed entries become
 * Klaro toggles; `consentManaged: false` entries are transparency
 * declarations only (services outside optional-cookie scope). This is the
 * shape a future shared package would consume per site.
 */
export interface ConsentService {
  name: string;
  title: string;
  description: string;
  /** Klaro purpose keys the service is grouped under in the consent UI. */
  purposes: string[];
  /** Consent Mode signals granted when the visitor consents. */
  consentSignals?: Partial<Record<ConsentSignal, "granted">>;
  /** Required services cannot be declined and render as always-on text. */
  required?: boolean;
  /**
   * Cookie-name patterns the service sets. Klaro deletes matching cookies
   * when consent is withdrawn.
   */
  cookies?: RegExp[];
  /** False = declared for transparency, not a switchable Klaro service. */
  consentManaged?: boolean;
}

export const CONSENT_SERVICES: ConsentService[] = [
  {
    name: "consent-preferences",
    title: "Essential",
    description:
      "Remembers your privacy choices so we don't keep asking.",
    purposes: ["functional"],
    required: true,
  },
  {
    name: "google-analytics",
    title: "Google Analytics",
    description:
      "Tells us which pages people visit and how the site is used — Google Analytics 4, delivered through Google Tag Manager. No advertising features are used.",
    purposes: ["analytics"],
    consentSignals: { analytics_storage: "granted" },
    cookies: [/^_ga/],
  },
  {
    name: "vercel-analytics",
    title: "Vercel Analytics",
    description:
      "Cookieless, aggregate usage and page-speed metrics collected by our hosting provider. It sets no cookies and stores no consent-gated data, so it is listed for transparency rather than as a switchable service.",
    purposes: ["analytics"],
    consentManaged: false,
  },
];

/**
 * Map stored Klaro service states to a full Consent Mode update. Signals
 * with no consenting service stay `denied`; a service's signals grant
 * only when the visitor consented to that service (or it is required).
 */
export function consentUpdateFromStates(
  states: Record<string, boolean>
): ConsentUpdate {
  const update: ConsentUpdate = {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    functionality_storage: "denied",
    personalization_storage: "denied",
    security_storage: "granted",
  };
  for (const service of CONSENT_SERVICES) {
    if (!service.consentSignals) continue;
    const consented = service.required === true || states[service.name] === true;
    if (!consented) continue;
    for (const signal of Object.keys(service.consentSignals) as ConsentSignal[]) {
      if (service.consentSignals[signal] === "granted") {
        update[signal] = "granted";
      }
    }
  }
  return update;
}

/**
 * Minimal shape of the Klaro config object we emit. Klaro is untyped JS;
 * this documents the subset we use.
 */
export interface KlaroConfig {
  version: number;
  elementID: string;
  storageMethod: "cookie";
  storageName: string;
  cookieExpiresAfterDays: number;
  mustConsent: boolean;
  acceptAll: boolean;
  hideDeclineAll: boolean;
  noticeAsModal: boolean;
  default: boolean;
  groupByPurpose: boolean;
  showNoticeTitle: boolean;
  disablePoweredBy: boolean;
  /**
   * Klaro's documented theming surface: each key is applied as a `--key`
   * CSS custom property on the `.klaro` element and consumed by its
   * stylesheet (`@include var(...)`). `theme` resolves a named preset
   * first; the other keys then override it.
   */
  styling: Record<string, string | string[]>;
  services: Array<{
    name: string;
    title: string;
    description: string;
    purposes: string[];
    required?: boolean;
    cookies?: RegExp[];
    default: boolean;
  }>;
  translations: Record<string, unknown>;
}

/**
 * Build the local Klaro configuration. Everything is bundled — no vendor
 * ID, no hosted service, no remote assets. `storageName` embeds the
 * policy version so a version bump deterministically requires a fresh
 * choice. Optional services are off by default (no preselected consent).
 */
export function buildKlaroConfig(): KlaroConfig {
  return {
    version: 2,
    elementID: "klaro",
    storageMethod: "cookie",
    storageName: CONSENT_STORAGE_NAME,
    cookieExpiresAfterDays: 180,
    mustConsent: false,
    acceptAll: true,
    hideDeclineAll: false,
    noticeAsModal: false,
    default: false,
    groupByPurpose: false,
    showNoticeTitle: true,
    disablePoweredBy: true,
    // DDB palette mapped onto Klaro's CSS-variable surface. The `light`
    // preset flips Klaro's default dark widget to light surfaces; the
    // overrides below then land the site's Paper/Ink/Stone tokens and
    // accent colors. Structural polish that variables cannot express
    // (button hierarchy, toggle, spacing, focus rings) lives in a scoped
    // `#klaro` section in globals.css — keep both in sync on Klaro upgrades.
    styling: {
      theme: ["light"],
      "border-radius": "10px",
      "font-size": "15px",
      "dark1": "#FAFAF8",
      "dark2": "#E6E7E3",
      "dark3": "#334E68",
      "light1": "#0B0F14",
      "light2": "#E6E7E3",
      "light3": "#0B0F14",
      "green1": "#0B0F14",
      "green2": "#2F6F4E",
      "green3": "#334E68",
      "blue1": "#0B0F14",
      "white2": "#E6E7E3",
      "white3": "#FAFAF8",
      "button-text-color": "#0B0F14",
    },
    services: CONSENT_SERVICES.filter((s) => s.consentManaged !== false).map(
      (s) => ({
        name: s.name,
        title: s.title,
        description: s.description,
        purposes: s.purposes,
        required: s.required,
        cookies: s.cookies,
        default: false,
      })
    ),
    translations: {
      en: {
        privacyPolicyUrl: "/privacy",
        ok: "Allow analytics",
        decline: "No thanks",
        acceptAll: "Allow analytics",
        acceptSelected: "Save preferences",
        save: "Save preferences",
        consentNotice: {
          title: "Cookies. Sadly, not the beer kind.",
          description:
            "We use a necessary cookie to remember your choices. If you're okay with it, we'd also like to use analytics to see how people use the site. No ads, no selling your data, no following you around the internet.",
          learnMore: "Manage preferences",
        },
        consentModal: {
          title: "Privacy preferences",
          description:
            "The essential stuff is always on so the site can remember your choices. Analytics is optional — allow it if you'd like to help us understand what's working. Either way, the beer remains unaffected.",
          privacyPolicy: {
            text: "Read our {privacyPolicy} for details.",
            name: "privacy policy",
          },
        },
        service: {
          required: { title: "(always on)" },
          purpose: "Purpose",
          purposes: "Purposes",
        },
        purposes: {
          functional: "Essential",
          analytics: "Analytics",
        },
      },
    },
  };
}

/**
 * Inline bootstrap that runs before the GTM container script. The
 * Consent Mode defaults are pushed first (deny-by-default until Klaro
 * reports a choice), then `gtm.start` — one script, impossible to race.
 * `window.gtag` is stubbed so both the default push and later
 * `consent` `update` commands serialize onto the same dataLayer command
 * queue that the container drains.
 */
export function buildGtmInitScript(): string {
  return `(window.dataLayer=window.dataLayer||[]);window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};window.gtag("consent","default",${JSON.stringify(CONSENT_DEFAULTS)});window.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js'});`;
}

/**
 * Push a `consent` `update` command onto the dataLayer queue. Prefers
 * the `gtag` stub the bootstrap installs; falls back to the raw
 * array-command form — identical entry either way. Never throws and
 * never runs on `/admin*`, where no marketing queue should exist.
 */
export function pushConsentUpdate(update: ConsentUpdate): void {
  if (typeof window === "undefined") return;
  if (window.location?.pathname?.startsWith("/admin") === true) return;
  try {
    const w = window as Window & {
      dataLayer?: unknown[];
      gtag?: (...args: unknown[]) => void;
    };
    w.dataLayer = w.dataLayer ?? [];
    if (typeof w.gtag === "function") {
      w.gtag("consent", "update", update);
    } else {
      w.dataLayer.push(["consent", "update", update]);
    }
  } catch {
    // Consent tooling must never break site functionality.
  }
}
