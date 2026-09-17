import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Private/test/placeholder/API surfaces are excluded from crawling;
        // they also carry noindex metadata or 404. This is discoverability
        // guidance only — access control lives in auth, not robots.txt.
        disallow: [
          "/admin",
          "/admin-fixture",
          "/trade/login",
          "/trade/order",
          "/trade/orders",
          "/api/",
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
