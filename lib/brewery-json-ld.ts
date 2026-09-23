import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_LEGAL_NAME,
  BUSINESS_NAME,
  SOCIAL_URLS,
  siteUrl,
} from "@/lib/site";
import { TELEPHONE_DISPLAY } from "@/lib/whatsapp";

/**
 * JSON-LD for the canonical Deep Dive Brewing `Brewery` entity
 * (`@id: <site>/#brewery`) — emitted identically on `/`, `/contact`,
 * `/trade`, and `/where-to-buy` (Issue #107).
 *
 * Every page emits the same complete field set so crawlers see one
 * consistent entity; page-specific schema (FAQPage, BreadcrumbList, beer
 * markup) stays local to its page. Business facts come from `lib/site.ts`
 * and `lib/whatsapp.ts` — never restate them here.
 */
export function buildBreweryJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Brewery",
    "@id": `${siteUrl}/#brewery`,
    name: BUSINESS_NAME,
    legalName: BUSINESS_LEGAL_NAME,
    url: siteUrl,
    image: `${siteUrl}/photos/og-default.jpg`,
    email: BUSINESS_EMAIL,
    telephone: TELEPHONE_DISPLAY,
    address: {
      "@type": "PostalAddress",
      ...BUSINESS_ADDRESS,
    },
    areaServed: [
      "Saba",
      "Sint Maarten",
      "Saint Martin",
      "SXM",
      "Sint Eustatius",
      "Statia",
    ],
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        opens: "08:00",
        closes: "15:00",
      },
    ],
    description:
      "Craft brewery based on Saba producing locally brewed beer with island-wide and regional partner distribution.",
    sameAs: [SOCIAL_URLS.instagram, SOCIAL_URLS.facebook, SOCIAL_URLS.untappd],
  };
}
