import type { Metadata } from "next";
import Link from "next/link";
import { Phone, Mail, Clock, MapPin } from "lucide-react";
import { ContactMap } from "@/components/contact-map";
import { TrackedAnchor } from "@/components/tracked-link";
import { serializeJsonLd } from "@/lib/json-ld";
import { siteUrl } from "@/lib/site";
import { TourInquiryCta } from "@/components/tour-inquiry-cta";

// User-initiated external navigation — opens Google Maps directions in a new
// tab. No third-party content is loaded into this page; the embedded map has
// its own click-to-load boundary in components/contact-map.tsx.
const DIRECTIONS_URL =
  "https://www.google.com/maps/dir/?api=1&destination=66+Fort+Bay+Road,+The+Bottom,+Saba";

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
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(localBusinessJsonLd) }}
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

      {/* Contact details + map share one bordered panel so the section reads
          as a single composition. The map column stretches to the info
          column's height on desktop, so the loaded map never leaves dead
          space beneath it. */}
      <div className="grid divide-y divide-stone overflow-hidden rounded-xl border border-stone bg-paper lg:grid-cols-5 lg:divide-x lg:divide-y-0">
        {/* Contact info */}
        <ul className="grid content-start gap-8 p-6 sm:p-8 md:grid-cols-2 lg:col-span-2 lg:grid-cols-1">
          {/* WhatsApp */}
          <li>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
                <Phone className="h-5 w-5 text-ink" aria-hidden="true" />
              </div>
              <h2 className="font-semibold">WhatsApp</h2>
            </div>
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
          </li>

          {/* Email — break-words (not break-all) keeps the address on one
              line whenever it fits and only breaks as a last resort on
              ultra-narrow screens, instead of splitting mid-domain. */}
          <li>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
                <Mail className="h-5 w-5 text-ink" aria-hidden="true" />
              </div>
              <h2 className="font-semibold">Email</h2>
            </div>
            <Link
              href="mailto:info@deepdivebrewing.com"
              className="mt-1 inline-flex min-h-[44px] items-center break-words text-ocean transition-opacity duration-200 hover:opacity-85"
              data-analytics-event="email_click"
              data-analytics-event-category="contact"
              data-analytics-cta-location="contact_page"
              data-analytics-event-label="Email"
            >
              info@deepdivebrewing.com
            </Link>
          </li>

          {/* Hours */}
          <li>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
                <Clock className="h-5 w-5 text-ink" aria-hidden="true" />
              </div>
              <h2 className="font-semibold">Hours</h2>
            </div>
            <p className="mt-1 text-muted-foreground">
              Typically open Monday to Friday, 8:00 AM to 3:00 PM.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Hours can vary. If the brewery is locked, check in with{" "}
              <span className="font-medium text-ink">Sea Saba</span> next door.
            </p>
          </li>

          {/* Location — Get directions lives here (not inside the map
              placeholder) so it stays available before AND after the
              embedded map is loaded. Same analytics contract as before. */}
          <li>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
                <MapPin className="h-5 w-5 text-ink" aria-hidden="true" />
              </div>
              <h2 className="font-semibold">Location</h2>
            </div>
            <p className="mt-1 text-muted-foreground">
              66 Fort Bay Road
              <br />
              The Bottom, Saba, Caribbean Netherlands
            </p>
            <a
              href={DIRECTIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-event="directions_click"
              data-analytics-event-category="conversion"
              data-analytics-event-label="Directions"
              data-analytics-cta-location="contact_page"
              className="inline-flex min-h-[44px] items-center text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              Get directions
            </a>
          </li>
        </ul>

        {/* Google Maps embed — click-to-load so /contact sends no request to
            Google until the visitor asks for it (see components/contact-map). */}
        <ContactMap className="lg:col-span-3" />
      </div>

      {/* Brewery tours — editorial two-option comparison, not pricing cards.
          The shared panel echoes the contact panel above so the transition
          into tours reads as part of the same page rhythm. */}
      <section className="mt-16 border-t border-stone pt-16" aria-labelledby="brewery-tours">
        <h2 id="brewery-tours" className="text-3xl font-bold tracking-tight">
          Brewery Tours
        </h2>
        <p className="mt-3 max-w-180 text-muted-foreground">
          See where the beer is made. Tours are available by request — send us
          a WhatsApp message and we&rsquo;ll find a time that works.
        </p>

        <div className="mt-10 grid divide-y divide-stone overflow-hidden rounded-xl border border-stone bg-paper md:grid-cols-2 md:divide-x md:divide-y-0">
          {/* Tour only */}
          <div className="p-6 sm:p-8">
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
            <TourInquiryCta
              tour="breweryTour"
              variant="outline"
              className="mt-5 h-11 min-h-[44px] px-6"
            >
              Arrange a brewery tour
            </TourInquiryCta>
          </div>

          {/* Tour + tasting */}
          <div className="p-6 sm:p-8">
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
            <TourInquiryCta
              tour="breweryTourTasting"
              className="mt-5 h-11 min-h-[44px] px-6"
            >
              Arrange tour + tasting
            </TourInquiryCta>
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
