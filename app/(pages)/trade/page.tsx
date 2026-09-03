import type { Metadata } from "next";
import Link from "next/link";
import { TradeInquiryForm } from "@/components/trade-inquiry-form";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";

export const metadata: Metadata = {
  title: "Trade & Wholesale",
  description:
    "Stock Deep Dive Brewing Co beer at your bar, restaurant, hotel, or retail location. Submit a trade inquiry for Saba, SXM, and nearby islands.",
  keywords: [
    "Deep Dive Brewing wholesale",
    "trade inquiry Saba",
    "craft beer distribution SXM",
    "Saba brewery trade",
    "beer wholesale Caribbean",
  ],
  alternates: {
    canonical: "/trade",
  },
  openGraph: {
    title: "Trade & Wholesale | Deep Dive Brewing Co",
    description:
      "Stock Deep Dive Brewing Co beer at your bar, restaurant, hotel, or retail location. Submit a trade inquiry.",
    url: "/trade",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co trade and wholesale",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Trade & Wholesale | Deep Dive Brewing Co",
    description:
      "Stock Deep Dive Brewing Co beer at your bar, restaurant, hotel, or retail location. Submit a trade inquiry.",
    images: ["/photos/og-default.jpg"],
  },
};

export default function TradePage() {
  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Brewery",
    "@id": `${siteUrl}/#brewery`,
    name: "Deep Dive Brewing Co",
    url: siteUrl,
    telephone: "+599-416-3544",
    email: "info@deepdivebrewing.com",
    address: {
      "@type": "PostalAddress",
      streetAddress: "66 Fort Bay Road",
      addressLocality: "The Bottom",
      addressCountry: "BQ",
    },
    areaServed: ["Saba", "Sint Maarten", "Saint Martin", "SXM", "Sint Eustatius", "Statia"],
  };

  return (
    <main id="main-content" className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Trade &amp; Wholesale
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Interested in carrying Deep Dive Brewing Co at your bar, restaurant,
          hotel, or retail location? We partner with accounts across Saba, SXM,
          and the surrounding islands.
        </p>
      </div>

      <section className="mb-12 rounded-lg border border-stone bg-stone/20 p-5">
        <h2 className="text-lg font-semibold text-ink">What to expect</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Core and seasonal beers in keg and can formats where available.</li>
          <li>Reliable supply from our Saba brewery.</li>
          <li>Local delivery on Saba and shipping coordination to SXM.</li>
          <li>Marketing support, staff notes, and tap handle assets on request.</li>
        </ul>
      </section>

      <section className="rounded-lg border border-stone bg-paper p-6 md:p-8">
        <h2 className="mb-6 text-2xl font-bold tracking-tight">Get in Touch</h2>
        <TradeInquiryForm />
      </section>

      <section className="mt-12 text-center">
        <p className="text-sm text-muted-foreground">
          Prefer email? Reach us directly at{" "}
          <Link
            href="mailto:info@deepdivebrewing.com"
            className="font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
          >
            info@deepdivebrewing.com
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
