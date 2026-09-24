import type { Metadata } from "next";
import Link from "next/link";
import { TradeInquiryForm } from "@/components/trade-inquiry-form";
import { serializeJsonLd } from "@/lib/json-ld";
import { buildBreweryJsonLd } from "@/lib/brewery-json-ld";
import { BUSINESS_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Trade & Wholesale",
  description:
    "Stock Deep Dive Brewing Co beer at your bar, restaurant, hotel, or retail location. Submit a trade inquiry for Saba, Sint Maarten / Saint Martin, and nearby islands.",
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
  // Canonical Brewery entity — shared builder (lib/brewery-json-ld.ts,
  // Issue #107) so all pages emit the identical complete field set.
  const breweryJsonLd = buildBreweryJsonLd();

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breweryJsonLd) }}
      />
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Trade &amp; Wholesale
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Interested in carrying Deep Dive Brewing Co at your bar, restaurant,
          hotel, or retail location? We partner with accounts across Saba,
          Sint Maarten / Saint Martin, and the surrounding islands.
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
            href={`mailto:${BUSINESS_EMAIL}`}
            className="font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            data-analytics-event="email_click"
            data-analytics-event-category="contact"
            data-analytics-cta-location="trade_page"
            data-analytics-event-label="Email"
          >
            {BUSINESS_EMAIL}
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
