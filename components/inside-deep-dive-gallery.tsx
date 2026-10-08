"use client";

import { useRef, useState } from "react";
import { PhotoFigure } from "@/components/photo-figure";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { Reveal } from "@/components/reveal";
import { BREWERY_PHOTOS } from "@/lib/brewery-photos";

// The gallery spans the full content column via `prose-breakout`
// (globals.css), so sizes are expressed against that width.
const FULL_SIZES = "(min-width: 1200px) 1152px, calc(100vw - 3rem)";
const COL_5_SIZES =
  "(min-width: 1200px) 470px, (min-width: 768px) 41vw, calc(100vw - 3rem)";
const COL_6_SIZES =
  "(min-width: 1200px) 560px, (min-width: 768px) 48vw, calc(100vw - 3rem)";
const COL_7_SIZES =
  "(min-width: 1200px) 653px, (min-width: 768px) 56vw, calc(100vw - 3rem)";

/**
 * "Inside Deep Dive" editorial photo section (Issue #193). The layout is
 * a deliberate composition, not a generic masonry: one dominant
 * establishing shot, an asymmetric portrait/detail pair, a swapped-side
 * detail pair, and an ingredient-to-wort closing pair. Every figure can
 * be enlarged into the shared PhotoLightbox.
 */
export function InsideDeepDiveGallery() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const open = (index: number) => (event: React.MouseEvent<HTMLElement>) => {
    // Stash the triggering figure so the lightbox can return focus to it
    // on close (there is no Dialog.Trigger for a controlled open).
    lastTriggerRef.current = event.currentTarget;
    setOpenIndex(index);
  };

  const [row, vessel, mash, valves, pipes, grain, wort] = BREWERY_PHOTOS;

  return (
    <>
      <Reveal className="prose-breakout mt-10">
        {/* dd-photo-grid (globals.css) undoes .prose-dd's disc + indent
            list styling; unlayered prose rules outrank utilities. */}
        <ul className="dd-photo-grid grid gap-6 md:grid-cols-12 md:gap-8">
          <li className="md:col-span-12">
            <PhotoFigure
              photo={row}
              aspectClass="aspect-[16/9]"
              sizes={FULL_SIZES}
              onEnlarge={open(0)}
            />
          </li>
          <li className="md:col-span-5">
            <PhotoFigure
              photo={vessel}
              aspectClass="aspect-[4/5]"
              imageClassName="object-[50%_30%]"
              sizes={COL_5_SIZES}
              onEnlarge={open(1)}
            />
          </li>
          <li className="md:col-span-7">
            <PhotoFigure
              photo={mash}
              aspectClass="aspect-[4/3]"
              sizes={COL_7_SIZES}
              onEnlarge={open(2)}
            />
          </li>
          <li className="md:col-span-7">
            <PhotoFigure
              photo={valves}
              aspectClass="aspect-[4/3]"
              sizes={COL_7_SIZES}
              onEnlarge={open(3)}
            />
          </li>
          <li className="md:col-span-5">
            <PhotoFigure
              photo={pipes}
              aspectClass="aspect-[4/3]"
              sizes={COL_5_SIZES}
              onEnlarge={open(4)}
            />
          </li>
          <li className="md:col-span-6">
            <PhotoFigure
              photo={grain}
              aspectClass="aspect-[4/3]"
              sizes={COL_6_SIZES}
              onEnlarge={open(5)}
            />
          </li>
          <li className="md:col-span-6">
            <PhotoFigure
              photo={wort}
              aspectClass="aspect-[4/3]"
              sizes={COL_6_SIZES}
              onEnlarge={open(6)}
            />
          </li>
        </ul>
      </Reveal>
      <PhotoLightbox
        photos={BREWERY_PHOTOS}
        index={openIndex}
        onIndexChange={setOpenIndex}
        returnFocusRef={lastTriggerRef}
      />
    </>
  );
}
