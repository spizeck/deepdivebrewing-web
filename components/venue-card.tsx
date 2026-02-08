import { Badge } from "@/components/ui/badge";
import type { Venue } from "@/lib/types";

interface VenueCardProps {
  venue: Venue;
}

export function VenueCard({ venue }: VenueCardProps) {
  return (
    <div className="rounded-lg border border-stone bg-paper p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold tracking-tight">{venue.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {venue.locationName}
          </p>
        </div>
        <Badge variant="outline">{venue.type}</Badge>
      </div>

      {venue.notesPublic && (
        <p className="mt-3 text-sm text-muted-foreground">{venue.notesPublic}</p>
      )}

      {(venue.links.website || venue.links.instagram) && (
        <div className="mt-4 flex gap-4">
          {venue.links.website && (
            <a
              href={venue.links.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              Website
            </a>
          )}
          {venue.links.instagram && (
            <a
              href={venue.links.instagram}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              Instagram
            </a>
          )}
        </div>
      )}
    </div>
  );
}
