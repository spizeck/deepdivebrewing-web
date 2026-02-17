import type { Metadata } from "next";
import Link from "next/link";
import { Phone, Mail, Clock, MapPin } from "lucide-react";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with Deep Dive Brewing Co on Saba. WhatsApp, email, or visit us at 66 Fort Bay Road.",
};

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Contact Us
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Have a question, want to place a trade order, or just want to say hi?
          We&rsquo;d love to hear from you.
        </p>
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Contact info */}
        <div className="space-y-8">
          {/* WhatsApp */}
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
              <Phone className="h-5 w-5 text-ink" />
            </div>
            <div>
              <h2 className="font-semibold">WhatsApp</h2>
              <Link
                href="https://wa.me/5994163544"
                className="mt-1 block text-ocean transition-opacity duration-200 hover:opacity-85"
                target="_blank"
                rel="noopener noreferrer"
              >
                +599-416-3544
              </Link>
            </div>
          </div>

          {/* Email */}
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
              <Mail className="h-5 w-5 text-ink" />
            </div>
            <div>
              <h2 className="font-semibold">Email</h2>
              <Link
                href="mailto:info@deepdivebrewing.com"
                className="mt-1 block text-ocean transition-opacity duration-200 hover:opacity-85"
              >
                info@deepdivebrewing.com
              </Link>
            </div>
          </div>

          {/* Hours */}
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
              <Clock className="h-5 w-5 text-ink" />
            </div>
            <div>
              <h2 className="font-semibold">Hours</h2>
              <p className="mt-1 text-muted-foreground">Varies</p>
              <p className="mt-2 text-sm text-muted-foreground">
                If the brewery is locked, check in with{" "}
                <span className="font-medium text-ink">Sea Saba</span> next
                door.
              </p>
            </div>
          </div>

          {/* Location */}
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone/50">
              <MapPin className="h-5 w-5 text-ink" />
            </div>
            <div>
              <h2 className="font-semibold">Location</h2>
              <p className="mt-1 text-muted-foreground">
                66 Fort Bay Road, Saba
              </p>
            </div>
          </div>

          {/* Brewery tours */}
          <div className="rounded-lg border border-stone bg-stone/20 p-5">
            <p className="text-sm font-semibold uppercase tracking-wider text-ink">
              Brewery Tours
            </p>
            <p className="mt-2 text-muted-foreground">
              Brewery tours are available upon request. Reach out via WhatsApp or
              email to schedule a visit.
            </p>
          </div>
        </div>

        {/* Google Maps embed */}
        <div className="rounded-xl border border-stone bg-paper p-4 md:p-5">
          <div className="relative aspect-16/10 w-full overflow-hidden rounded-xl">
            <iframe
              className="absolute inset-0 h-full w-full"
              src="https://maps.google.com/maps?width=600&amp;height=400&amp;hl=en&amp;q=66 fort bay road&amp;t=&amp;z=16&amp;ie=UTF8&amp;iwloc=B&amp;output=embed"
              title="Deep Dive Brewing Co location"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </div>
    </main>
  );
}
