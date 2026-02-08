import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { Beer } from "@/lib/types";

interface BeerCardProps {
  beer: Beer;
}

export function BeerCard({ beer }: BeerCardProps) {
  return (
    <Link
      href={`/beers/${beer.slug}`}
      className="group block rounded-lg border border-stone bg-paper transition-opacity duration-200 hover:opacity-85"
    >
      <div className="relative aspect-3/4 w-full overflow-hidden rounded-t-lg">
        <Image
          src={beer.images.hero}
          alt={beer.name}
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
      </div>
      <div className="p-6">
        <h3 className="text-xl font-semibold tracking-tight">{beer.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{beer.style}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="secondary">{beer.abv}% ABV</Badge>
          <Badge variant="outline">{beer.status}</Badge>
        </div>
        <p className="mt-3 text-sm text-muted-foreground line-clamp-2">
          {beer.descriptionShort}
        </p>
      </div>
    </Link>
  );
}
