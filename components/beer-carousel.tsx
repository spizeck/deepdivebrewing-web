"use client";

import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import { useCallback } from "react";
import { BeerCard } from "@/components/beer-card";
import type { Beer } from "@/lib/types";

interface BeerCarouselProps {
  beers: Beer[];
  imageUrls: Record<string, string>;
}

export function BeerCarousel({ beers, imageUrls }: BeerCarouselProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel(
    { loop: true, align: "start", slidesToScroll: 1 },
    [Autoplay({ delay: 4000, stopOnInteraction: true })]
  );

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi]);

  return (
    <div className="relative">
      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex gap-6">
          {beers.map((beer) => (
            <div
              key={beer.slug}
              className="min-w-0 flex-[0_0_85%] sm:flex-[0_0_45%] lg:flex-[0_0_30%]"
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
        className="absolute -left-4 top-1/3 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-stone bg-paper shadow-sm transition-opacity hover:opacity-75"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <button
        onClick={scrollNext}
        aria-label="Next beer"
        className="absolute -right-4 top-1/3 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-stone bg-paper shadow-sm transition-opacity hover:opacity-75"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
