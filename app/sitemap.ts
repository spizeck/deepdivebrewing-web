import type { MetadataRoute } from "next";
import { getBeers } from "@/lib/beers";
import { siteUrl } from "@/lib/site";

// No lastModified: the build has no real per-page modification dates (beer
// content changes in Firestore, not on deploy), so a fabricated timestamp
// would be worse than omitting the field.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${siteUrl}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/where-to-buy`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${siteUrl}/beers`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteUrl}/about`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${siteUrl}/contact`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${siteUrl}/trade`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${siteUrl}/privacy`,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${siteUrl}/terms`,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  const beers = await getBeers();
  const beerRoutes: MetadataRoute.Sitemap = beers.map((beer) => ({
    url: `${siteUrl}/beers/${beer.slug}`,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...staticRoutes, ...beerRoutes];
}
