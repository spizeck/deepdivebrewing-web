import { siteUrl } from "@/lib/site";

/**
 * JSON-LD for `/beers/[slug]` detail pages.
 *
 * These are informational brewery pages: Deep Dive distributes beer through
 * retailers and does not sell through this site, so the pages emit no
 * `Product` markup. Google's product snippet feature requires `offers`,
 * `review`, or `aggregateRating` — none of which exist here and none of which
 * may be fabricated — so a bare `Product` node only produced a Search Console
 * error while misrepresenting the page as a purchase candidate (Issue #81).
 *
 * `BreadcrumbList` is retained because it mirrors the visible breadcrumb nav
 * (Our Beers → beer name) and is a real Google Search feature that needs no
 * commerce data.
 */
export function buildBeerJsonLd(beer: { name: string; slug: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Our Beers",
        item: `${siteUrl}/beers`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: beer.name,
        item: `${siteUrl}/beers/${beer.slug}`,
      },
    ],
  };
}
