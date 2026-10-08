import type { UpdateEntry } from "@/lib/updates";

/**
 * The Updates registry (Issue #194) — one entry per published (or drafted)
 * update. Each entry's body is a sibling `.mdx` file; `loadBody` keeps
 * archive/sitemap readers out of the MDX module graph.
 *
 * To publish a new update: create `content/updates/<slug>.mdx`, then add
 * its entry here. See docs/operations/updates.md for the full recipe.
 */
export const updateEntries: UpdateEntry[] = [
  {
    slug: "brew-day-at-fort-bay",
    title: "Brew Day at Fort Bay",
    publishedAt: "2026-10-06",
    summary:
      "A look inside a brew day at our little brewhouse on Fort Bay Harbor — grain in the mill, wort in the kettle, and a fresh batch on its way to the tanks.",
    image: {
      src: "/photos/herograin.jpg",
      alt: "Freshly milled malt moving through the grain auger on a brew day",
      caption: "Milled malt on its way to the mash tun.",
    },
    cta: { label: "Find a pour near you", href: "/where-to-buy" },
    loadBody: () => import("./brew-day-at-fort-bay.mdx"),
  },
];
