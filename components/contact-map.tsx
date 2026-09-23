"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUSINESS_ADDRESS } from "@/lib/site";

// Contextual consent boundary (Issue #77): the Google Maps embed is never
// rendered into the page until the visitor explicitly asks for it. That keeps
// /contact free of Google requests before a choice is made — Maps is a
// functional embed, not analytics, so it is deliberately not a Klaro service.
// The choice is component state only: nothing is persisted, and loading works
// identically whether analytics consent is granted or denied.
const MAP_EMBED_URL =
  "https://www.google.com/maps?q=66+Fort+Bay+Road,+The+Bottom,+Saba&output=embed";

interface ContactMapProps {
  // Grid placement is owned by the page layout (e.g. "lg:col-span-3").
  className?: string;
}

export function ContactMap({ className }: ContactMapProps) {
  const [mapRequested, setMapRequested] = useState(false);

  // Sizing: on lg+ the page's grid stretches this cell to the contact-info
  // column's height, so placeholder and iframe both fill the panel — no dead
  // space beneath the map. Below lg the map sits in a stacked row: a fixed
  // min-height on narrow screens (aspect + min-height transfers into a
  // min-width that would overflow small viewports), then a 16:9 ratio once
  // there's room. lg:min-h-80 floors the stretched height if the info column
  // is ever shorter.
  return (
    <div
      className={cn(
        "relative min-h-72 w-full overflow-hidden sm:aspect-video lg:aspect-auto lg:min-h-80",
        className
      )}
    >
      {mapRequested ? (
        <iframe
          className="absolute inset-0 h-full w-full"
          src={MAP_EMBED_URL}
          title="Deep Dive Brewing Co location"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-stone/40 px-4 py-6 text-center">
          <MapPin className="h-5 w-5 text-ink" aria-hidden="true" />
          <p className="font-semibold tracking-tight">Find us at Fort Bay</p>
          <p className="text-sm text-muted-foreground">
            {BUSINESS_ADDRESS.streetAddress}, {BUSINESS_ADDRESS.addressLocality}, Saba
          </p>
          <p className="text-sm text-muted-foreground">
            Want the interactive map? Load it when you need it.
          </p>
          <button
            type="button"
            onClick={() => setMapRequested(true)}
            className="mt-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity duration-200 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/50"
          >
            Load map
          </button>
          <p className="text-xs text-muted-foreground">
            Loading the map connects your browser to Google.
          </p>
        </div>
      )}
    </div>
  );
}
