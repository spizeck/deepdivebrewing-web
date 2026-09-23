"use client";

import useEmblaCarousel from "embla-carousel-react";
import { useCallback } from "react";
import { BeerCard } from "@/components/beer-card";
import type { Beer } from "@/lib/types";

interface BeerCarouselProps {
  beers: Beer[];
  imageUrls: Record<string, string>;
}

export function BeerCarousel({ beers, imageUrls }: BeerCarouselProps) {
  // No autoplay: THEME_AND_BRANDING.md forbids auto-playing carousels and
  // WCAG 2.2.2 requires a pause/stop control for auto-updating content.
  // The carousel advances only via the explicit arrow buttons or drag.
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: true,
    align: "start",
    slidesToScroll: 1,
  });

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi]);

  return (
    <div
      className="relative"
      role="region"
      aria-roledescription="carousel"
      aria-label="Featured beers"
    >
      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex gap-6">
          {beers.map((beer, index) => (
            <div
              key={beer.slug}
              className="min-w-0 flex-[0_0_85%] sm:flex-[0_0_45%] lg:flex-[0_0_30%]"
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${beers.length}`}
              // Keyboard accessibility: a tabbed-to slide that is partly or
              // fully off-screen is scrolled into view. The :focus-visible
              // gate limits that to keyboard focus — a pointer click/tap on
              // the card link must not re-align the carousel ahead of
              // navigation.
              onFocus={(event) => {
                if ((event.target as HTMLElement).matches(":focus-visible")) {
                  emblaApi?.scrollTo(index);
                }
              }}
            >
              <BeerCard beer={beer} imageUrl={imageUrls[beer.slug]} />
            </div>
          ))}
        </div>
      </div>

      {/* Navigation arrows */}
      <button
        onClick={scrollPrev}
        aria-label="Previous beer"
        className="absolute -left-4 top-1/3 z-10 flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-stone bg-paper shadow-sm transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ocean/50"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <button
        onClick={scrollNext}
        aria-label="Next beer"
        className="absolute -right-4 top-1/3 z-10 flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-stone bg-paper shadow-sm transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ocean/50"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
