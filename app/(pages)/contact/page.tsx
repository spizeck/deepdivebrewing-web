import type { Metadata } from "next";
import Link from "next/link";
import { Phone, Mail, Clock, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrackedAnchor } from "@/components/tracked-link";
import { siteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Contact Deep Dive Brewing Co at 66 Fort Bay Road, The Bottom, Saba, Caribbean Netherlands. Reach us fastest on WhatsApp.",
  keywords: [
    "Deep Dive Brewing contact",
    "brewery Saba contact",
    "66 Fort Bay Road The Bottom Saba",
    "Deep Dive Brewing WhatsApp",
  ],
  alternates: {
    canonical: "/contact",
  },
  openGraph: {
    title: "Contact | Deep Dive Brewing Co",
    description:
      "Contact Deep Dive Brewing Co at 66 Fort Bay Road, The Bottom, Saba, Caribbean Netherlands. Reach us fastest on WhatsApp.",
    url: "/contact",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co contact",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Contact | Deep Dive Brewing Co",
    description:
      "Contact Deep Dive Brewing Co at 66 Fort Bay Road, The Bottom, Saba, Caribbean Netherlands. Reach us fastest on WhatsApp.",
    images: ["/photos/og-default.jpg"],
  },
};

export default function ContactPage() {
  const localBusinessJsonLd = {
    "@context": "https://schema.org",
    "@type": "Brewery",
    "@id": `${siteUrl}/#brewery`,
    name: "Deep Dive Brewing Co",
    legalName: "Deep Dive Brews, BV",
    url: siteUrl,
    telephone: "+599-416-3544",
    email: "info@deepdivebrewing.com",
    address: {
      "@type": "PostalAddress",
      streetAddress: "66 Fort Bay Road",
      addressLocality: "The Bottom",
      addressCountry: "BQ",
    },
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        opens: "08:00",
        closes: "15:00",
      },
    ],
    areaServed: ["Saba", "Sint Maarten", "Saint Martin", "SXM", "Sint Eustatius", "Statia"],
    sameAs: [
      "https://www.instagram.com/deepdivebrewing",
      "https://www.facebook.com/deepdivebrewing",
      "https://untappd.com/DeepDiveBrewingCo",
    ],
  };

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd) }}
      />
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Contact Us
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Have a question, want to place a trade order, or want to see where
          the beer is made? We&rsquo;d love to hear from you.
        </p>
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Contact info */}
        <div className="grid content-start gap-6 sm:grid-cols-2">
          {/* WhatsApp */}
          <div className="rounded-lg border border-stone bg-paper p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-stone/50">
              <Phone className="h-5 w-5 text-ink" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-semibold">WhatsApp</h2>
            <TrackedAnchor
              href="https://wa.me/5994163544"
              eventName="whatsapp_click"
              eventParams={{ event_category: "contact", cta_location: "contact_page", event_label: "WhatsApp" }}
              className="mt-1 inline-flex min-h-[44px] items-center text-ocean transition-opacity duration-200 hover:opacity-85"
              target="_blank"
              rel="noopener noreferrer"
            >
              +599-416-3544
            </TrackedAnchor>
          </div>

          {/* Email */}
          <div className="rounded-lg border border-stone bg-paper p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-stone/50">
              <Mail className="h-5 w-5 text-ink" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-semibold">Email</h2>
            <Link
              href="mailto:info@deepdivebrewing.com"
              className="mt-1 inline-flex min-h-[44px] items-center break-all text-sm text-ocean transition-opacity duration-200 hover:opacity-85"
              data-analytics-event="email_click"
              data-analytics-event-category="contact"
              data-analytics-cta-location="contact_page"
              data-analytics-event-label="Email"
            >
              info@deepdivebrewing.com
            </Link>
          </div>

          {/* Hours */}
          <div className="rounded-lg border border-stone bg-paper p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-stone/50">
              <Clock className="h-5 w-5 text-ink" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-semibold">Hours</h2>
            <p className="mt-1 text-muted-foreground">
              Typically open Monday to Friday, 8:00 AM to 3:00 PM.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Hours can vary. If the brewery is locked, check in with{" "}
              <span className="font-medium text-ink">Sea Saba</span> next door.
            </p>
          </div>

          {/* Location */}
          <div className="rounded-lg border border-stone bg-paper p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-stone/50">
              <MapPin className="h-5 w-5 text-ink" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-semibold">Location</h2>
            <p className="mt-1 text-muted-foreground">
              66 Fort Bay Road, The Bottom, Saba, Caribbean Netherlands
            </p>
          </div>
        </div>

        {/* Google Maps embed */}
        <div className="rounded-xl border border-stone bg-paper p-4 md:p-5">
          <div className="relative aspect-16/10 w-full overflow-hidden rounded-xl">
            <iframe
              className="absolute inset-0 h-full w-full"
              src="https://www.google.com/maps?q=66+Fort+Bay+Road,+The+Bottom,+Saba&output=embed"
              title="Deep Dive Brewing Co location"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </div>

      {/* Brewery tours — editorial two-option comparison, not pricing cards */}
      <section className="mt-16 border-t border-stone pt-16" aria-labelledby="brewery-tours">
        <h2 id="brewery-tours" className="text-3xl font-bold tracking-tight">
          Brewery Tours
        </h2>
        <p className="mt-3 max-w-180 text-muted-foreground">
          See where the beer is made. Tours are available by request — send us
          a WhatsApp message and we&rsquo;ll find a time that works.
        </p>

        <div className="mt-10 grid max-w-220 gap-10 md:grid-cols-2 md:gap-0">
          {/* Tour only */}
          <div className="md:pr-12">
            <h3 className="text-lg font-semibold tracking-tight">
              Brewery Tour
            </h3>
            <p className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight">$20</span>
              <span className="text-sm text-muted-foreground">
                per person · ~30 minutes
              </span>
            </p>
            <p className="mt-3 text-muted-foreground">
              A walk through the brewery — how the beer actually gets made.
            </p>
            <p className="mt-2 text-sm font-medium text-ink">
              No beer or tasting included.
            </p>
            <Button
              asChild
              variant="outline"
              className="mt-5 h-11 min-h-[44px] px-6"
            >
              <Link
                href="https://wa.me/5994163544"
                target="_blank"
                rel="noopener noreferrer"
                data-analytics-event="tour_inquiry_click"
                data-analytics-event-category="conversion"
                data-analytics-event-label="Brewery Tour"
                data-analytics-cta-location="contact_page_tours"
              >
                Arrange a brewery tour
              </Link>
            </Button>
          </div>

          {/* Tour + tasting */}
          <div className="border-t border-stone pt-8 md:border-l md:border-t-0 md:pl-12 md:pt-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-moss">
              Stay for a taste
            </p>
            <h3 className="mt-1 text-lg font-semibold tracking-tight">
              Brewery Tour + Tasting
            </h3>
            <p className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight">$40</span>
              <span className="text-sm text-muted-foreground">
                per person · ~60 minutes total
              </span>
            </p>
            <p className="mt-3 text-muted-foreground">
              The same brewery tour, then about 30 minutes for the important
              part.
            </p>
            <p className="mt-2 text-sm font-medium text-ink">
              Generous beer tastings included.
            </p>
            <Button asChild className="mt-5 h-11 min-h-[44px] px-6">
              <Link
                href="https://wa.me/5994163544"
                target="_blank"
                rel="noopener noreferrer"
                data-analytics-event="tour_inquiry_click"
                data-analytics-event-category="conversion"
                data-analytics-event-label="Brewery Tour + Tasting"
                data-analytics-cta-location="contact_page_tours"
              >
                Arrange tour + tasting
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mt-16 border-t border-stone pt-16" aria-labelledby="contact-faq">
        <div className="max-w-180 rounded-lg">
          <h2 id="contact-faq" className="text-2xl font-bold tracking-tight">
            Contact FAQ
          </h2>
          <div className="mt-6 space-y-5 text-muted-foreground">
            <div>
              <h3 className="font-medium text-ink">Do you have a taproom?</h3>
              <p className="mt-1">
                No taproom at this time — but you can visit the brewery itself
                on a tour.
              </p>
            </div>
            <div>
              <h3 className="font-medium text-ink">What is the fastest way to reach you?</h3>
              <p className="mt-1">
                WhatsApp at +599-416-3544 is the fastest channel for inquiries.
              </p>
            </div>
            <div>
              <h3 className="font-medium text-ink">Where are you distributing?</h3>
              <p className="mt-1">
                We currently focus on Saba and select partner accounts in SXM,
                with expansion in progress.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
