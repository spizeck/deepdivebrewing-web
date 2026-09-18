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
