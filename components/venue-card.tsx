import { Badge } from "@/components/ui/badge";
import type { Venue } from "@/lib/types";

const typeLabels: Record<Venue["type"], string> = {
  bar_restaurant: "Bar / Restaurant",
  retail: "Retail",
};

interface VenueCardProps {
  venue: Venue;
  beerNameBySlug: Record<string, string>;
}

export function VenueCard({ venue, beerNameBySlug }: VenueCardProps) {
  const tapBeers = (venue.tapBeerSlugs ?? []).map((slug) => beerNameBySlug[slug] ?? slug);
  const canBeers = (venue.canBeerSlugs ?? []).map((slug) => beerNameBySlug[slug] ?? slug);
  const island = venue.locationName ?? "Saba";

  return (
    <div className="rounded-lg border border-stone bg-paper p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold tracking-tight">{venue.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {venue.locationName}
          </p>
        </div>
        <Badge variant="outline">{typeLabels[venue.type]}</Badge>
      </div>

      {venue.notesPublic && (
        <p className="mt-3 text-sm text-muted-foreground">{venue.notesPublic}</p>
      )}

      {(tapBeers.length > 0 || canBeers.length > 0) && (
        <div className="mt-4 space-y-2 text-sm text-muted-foreground">
          {tapBeers.length > 0 && (
            <p>
              <span className="font-semibold text-ink">On Tap:</span>{" "}
              {tapBeers.join(", ")}
            </p>
          )}
          {canBeers.length > 0 && (
            <p>
              <span className="font-semibold text-ink">In Can:</span>{" "}
              {canBeers.join(", ")}
            </p>
          )}
        </div>
      )}

      {(venue.links.website || venue.links.maps || venue.links.instagram || venue.links.facebook || venue.links.untappd) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {venue.links.maps && (
            <a
              href={venue.links.maps}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-event="directions_click"
              data-analytics-event-category="conversion"
              data-analytics-event-label="Directions"
              data-analytics-partner-name={venue.name}
              data-analytics-island={island}
              data-analytics-venue-type={typeLabels[venue.type]}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity duration-200 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/50"
            >
              Directions
            </a>
          )}
          {venue.links.website && (
            <a
              href={venue.links.website}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-event="where_to_buy_click"
              data-analytics-event-category="conversion"
              data-analytics-event-label="Website"
              data-analytics-partner-name={venue.name}
              data-analytics-island={island}
              data-analytics-venue-type={typeLabels[venue.type]}
              className="inline-flex min-h-[44px] min-w-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean/50"
            >
              Website
            </a>
          )}
          {venue.links.instagram && (
            <a
              href={venue.links.instagram}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${venue.name} on Instagram`}
              className="inline-flex min-h-[44px] min-w-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean/50"
            >
              Instagram
            </a>
          )}
          {venue.links.facebook && (
            <a
              href={venue.links.facebook}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${venue.name} on Facebook`}
              className="inline-flex min-h-[44px] min-w-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean/50"
            >
              Facebook
            </a>
          )}
          {venue.links.untappd && (
            <a
              href={venue.links.untappd}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${venue.name} on Untappd`}
              className="inline-flex min-h-[44px] min-w-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean/50"
            >
              Untappd
            </a>
          )}
        </div>
      )}
    </div>
  );
}
