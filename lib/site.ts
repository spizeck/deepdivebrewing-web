// Canonical site origin — the single source of truth for canonical URLs,
// sitemap/robots URLs, Open Graph URLs, and JSON-LD `@id`s. Overridable via
// NEXT_PUBLIC_SITE_URL; the resolved value never has a trailing slash so
// callers can safely build `${siteUrl}/path` URLs.
export function resolveSiteUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL
): string {
  return (raw ?? "https://deepdivebrewing.com").replace(/\/+$/, "");
}

export const siteUrl = resolveSiteUrl();

// Canonical business facts (Issue #107) — the single source of truth for
// values repeated across pages: the Brewery JSON-LD entity
// (lib/brewery-json-ld.ts), mailto: links, contact details, and footer
// social profiles. Firebase-free so client components may import it.
//
// The phone/WhatsApp number is deliberately absent: `lib/whatsapp.ts` owns
// the digits (WHATSAPP_NUMBER → whatsappUrl/TELEPHONE_DISPLAY) — never
// restate them here.
export const BUSINESS_NAME = "Deep Dive Brewing Co";
export const BUSINESS_LEGAL_NAME = "Deep Dive Brews, BV";
export const BUSINESS_EMAIL = "info@deepdivebrewing.com";

// Keys mirror schema.org PostalAddress so the Brewery entity can spread them
// directly; they also serve visible address copy (street, locality lines).
export const BUSINESS_ADDRESS = {
  streetAddress: "66 Fort Bay Road",
  addressLocality: "The Bottom",
  addressCountry: "BQ",
} as const;

// The brewery's own social profiles — used by the JSON-LD `sameAs` list and
// the site footer links.
export const SOCIAL_URLS = {
  instagram: "https://www.instagram.com/deepdivebrewing",
  facebook: "https://www.facebook.com/deepdivebrewing",
  untappd: "https://untappd.com/DeepDiveBrewingCo",
} as const;
