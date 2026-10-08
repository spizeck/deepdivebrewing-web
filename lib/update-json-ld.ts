import { BUSINESS_NAME, siteUrl } from "@/lib/site";
import type { Update } from "@/lib/updates";

/**
 * JSON-LD for `/updates/[slug]` detail pages (Issue #194).
 *
 * `BlogPosting` is the accurate type: these are dated editorial posts by
 * the brewery itself. The author is the business entity
 * (`@id: <site>/#brewery`, the same canonical Brewery node emitted by
 * `buildBreweryJsonLd`) — no individual author is invented. Only fields
 * that reflect real page content are emitted; drafts never reach this
 * builder because they 404 before render.
 */
export function buildUpdateJsonLd(update: Update) {
  const url = `${siteUrl}/updates/${update.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${url}#post`,
    headline: update.title,
    description: update.summary,
    datePublished: update.publishedAt,
    mainEntityOfPage: url,
    url,
    ...(update.image
      ? {
          image: /^https?:\/\//.test(update.image.src)
            ? update.image.src
            : `${siteUrl}${update.image.src}`,
        }
      : {}),
    author: { "@id": `${siteUrl}/#brewery` },
    publisher: {
      "@type": "Brewery",
      "@id": `${siteUrl}/#brewery`,
      name: BUSINESS_NAME,
    },
  };
}
