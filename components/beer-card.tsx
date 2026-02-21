import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { beerImageUrl } from "@/lib/beers";
import type { Beer } from "@/lib/types";

interface BeerCardProps {
  beer: Beer;
  imageUrl?: string;
}

export function BeerCard({ beer, imageUrl }: BeerCardProps) {
  return (
    <Link
      href={`/beers/${beer.slug}`}
      className="group block rounded-lg border border-stone bg-paper transition-opacity duration-200 hover:opacity-85"
    >
      <div className="relative aspect-4/5 w-full overflow-hidden rounded-t-lg">
        <Image
          src={imageUrl ?? beerImageUrl(beer.images.cardPath)}
          alt={beer.name}
          fill
          quality={75}
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
