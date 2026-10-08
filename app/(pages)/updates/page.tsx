import type { Metadata } from "next";
import { UpdatesArchive } from "@/components/updates-archive";
import { getPublishedUpdates } from "@/lib/updates";

export const metadata: Metadata = {
  title: "Updates",
  description:
    "News from Deep Dive Brewing Co — beer releases, new places to find a pour, brewery announcements, and stories from the brewhouse on Saba.",
  alternates: {
    canonical: "/updates",
  },
  openGraph: {
    title: "Updates | Deep Dive Brewing Co",
    description:
      "News from Deep Dive Brewing Co — beer releases, new places to find a pour, brewery announcements, and stories from the brewhouse on Saba.",
    url: "/updates",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co brewery",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Updates | Deep Dive Brewing Co",
    description:
      "News from Deep Dive Brewing Co — beer releases, new places to find a pour, brewery announcements, and stories from the brewhouse on Saba.",
    images: ["/photos/og-default.jpg"],
  },
};

export default function UpdatesPage() {
  const updates = getPublishedUpdates();

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-300 px-6 pb-20 md:pb-30"
    >
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Updates
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          News from the brewhouse — fresh beers, new places to find a pour,
          and life at the brewery on Saba.
        </p>
      </div>

      <UpdatesArchive updates={updates} />
    </main>
  );
}
