import Link from "next/link";
import { PhotoFigure } from "@/components/photo-figure";
import { Reveal } from "@/components/reveal";
import { BREWERY_PHOTOS } from "@/lib/brewery-photos";

/**
 * Restrained homepage teaser for the "Inside Deep Dive" photography
 * section on /about (Issue #193): one compelling photo, short copy, one
 * CTA — deliberately a photo/text split so it reads differently from the
 * full-bleed hero and the brewery video band above it.
 */
export function InsideDeepDiveTeaser() {
  const photo = BREWERY_PHOTOS.find((p) => p.id === "alpha-vessel")!;

  return (
    <Reveal as="section" className="border-t border-stone">
      <div className="mx-auto max-w-300 px-6 py-20 md:py-30">
        <div className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
          <PhotoFigure
            photo={photo}
            aspectClass="aspect-[4/5]"
            imageClassName="object-[50%_30%]"
            sizes="(min-width: 1200px) 552px, (min-width: 768px) calc(50vw - 4rem), calc(100vw - 3rem)"
            showCaption={false}
          />
          <div>
            <h2 className="text-3xl font-bold tracking-tight">
              Inside Deep Dive
            </h2>
            <p className="mt-4 text-muted-foreground">
              Step inside our 26-by-26-foot brewery at Fort Bay Harbor
              for a closer look at the tanks, valves, and grain behind
              every batch.
            </p>
            <Link
              href="/about"
              className="mt-6 inline-flex min-h-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              See inside the brewery &rarr;
            </Link>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
