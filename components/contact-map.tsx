"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";

// Contextual consent boundary (Issue #77): the Google Maps embed is never
// rendered into the page until the visitor explicitly asks for it. That keeps
// /contact free of Google requests before a choice is made — Maps is a
// functional embed, not analytics, so it is deliberately not a Klaro service.
// The choice is component state only: nothing is persisted, and loading works
// identically whether analytics consent is granted or denied.
const MAP_EMBED_URL =
  "https://www.google.com/maps?q=66+Fort+Bay+Road,+The+Bottom,+Saba&output=embed";

// User-initiated external navigation — opens Google Maps directions in a new
// tab. No third-party content is loaded into this page.
const DIRECTIONS_URL =
  "https://www.google.com/maps/dir/?api=1&destination=66+Fort+Bay+Road,+The+Bottom,+Saba";

export function ContactMap() {
  const [mapRequested, setMapRequested] = useState(false);

  // Both states fill the same box, so swapping placeholder → iframe cannot
  // shift the layout. sm:aspect-16/10 matches the previous embed's shape on
  // larger screens; on narrow screens a fixed min-height stands in — an
  // aspect ratio combined with min-height transfers into a min-width that
  // would overflow small viewports.
  return (
    <div className="relative min-h-64 w-full overflow-hidden rounded-xl sm:aspect-16/10">
      {mapRequested ? (
        <iframe
          className="absolute inset-0 h-full w-full"
          src={MAP_EMBED_URL}
          title="Deep Dive Brewing Co location"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-stone/40 px-4 text-center">
          <MapPin className="h-5 w-5 text-ink" aria-hidden="true" />
          <p className="font-semibold tracking-tight">Find us at Fort Bay</p>
          <p className="text-sm text-muted-foreground">
            66 Fort Bay Road, The Bottom, Saba
          </p>
          <p className="text-sm text-muted-foreground">
            Want the interactive map? Load it when you need it.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setMapRequested(true)}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity duration-200 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/50"
            >
              Load map
            </button>
            <a
              href={DIRECTIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-event="directions_click"
              data-analytics-event-category="conversion"
              data-analytics-event-label="Directions"
              data-analytics-cta-location="contact_page"
              className="inline-flex min-h-[44px] min-w-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean/50"
            >
              Get directions
            </a>
          </div>
          <p className="text-xs text-muted-foreground">
            Loading the map connects your browser to Google.
          </p>
        </div>
      )}
    </div>
  );
}
