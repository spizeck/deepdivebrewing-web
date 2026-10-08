"use client";

import Image from "next/image";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn, pressableClasses } from "@/lib/utils";
import type { BreweryPhoto } from "@/lib/brewery-photos";

interface PhotoLightboxProps {
  photos: readonly BreweryPhoto[];
  /** Index of the photo being viewed; null when closed. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
  /**
   * The figure button that opened the viewer — focus returns here on
   * close. Radix's default restore only fires when a Dialog.Trigger
   * exists; this ref supplies the equivalent for controlled opens.
   */
  returnFocusRef: React.RefObject<HTMLElement | null>;
}

const controlClasses = cn(
  "absolute z-10 inline-flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-ink/55 text-paper backdrop-blur-sm transition-[background-color,opacity] hover:bg-ink/75 focus-visible:outline-paper",
  pressableClasses
);

/**
 * Keyboard-accessible photo viewer (Issue #193) built on Radix Dialog:
 * role=dialog + aria-modal, Escape-to-close, focus trap and focus return
 * to the triggering figure, and body-scroll lock come from the
 * primitive. ArrowLeft/ArrowRight step through the set (wrapping at the
 * ends); the caption region is the dialog description and announces
 * each photo change politely.
 */
export function PhotoLightbox({
  photos,
  index,
  onIndexChange,
  returnFocusRef,
}: PhotoLightboxProps) {
  const count = photos.length;
  const photo = index === null ? null : photos[index];
  const go = (next: number) =>
    onIndexChange(((next % count) + count) % count);

  return (
    <DialogPrimitive.Root
      open={index !== null}
      onOpenChange={(open) => {
        if (!open) onIndexChange(null);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/85 motion-reduce:animate-none data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center outline-none motion-reduce:animate-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              go((index ?? 0) + 1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              go((index ?? 0) - 1);
            }
          }}
          onClick={(event) => {
            // Backdrop click dismisses — the figure and controls stop
            // propagation by living inside this full-viewport content.
            if (event.target === event.currentTarget) onIndexChange(null);
          }}
          onCloseAutoFocus={(event) => {
            // Radix's default close-focus targets Dialog.Trigger, which a
            // controlled open never registers — restore the figure button
            // that opened the viewer instead.
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Inside Deep Dive photo viewer
          </DialogPrimitive.Title>

          {photo ? (
            <figure className="flex w-full flex-col items-center gap-3 px-4">
              <div className="relative h-[72dvh] w-[min(92vw,110rem)]">
                <Image
                  src={photo.src}
                  alt={photo.alt}
                  fill
                  sizes="92vw"
                  className="object-contain"
                />
              </div>
              <DialogPrimitive.Description asChild>
                <figcaption
                  aria-live="polite"
                  className="max-w-2xl text-center text-sm text-paper/90"
                >
                  {photo.caption}{" "}
                  <span className="text-paper/60">
                    Photo {(index ?? 0) + 1} of {count}.
                  </span>
                </figcaption>
              </DialogPrimitive.Description>
            </figure>
          ) : null}

          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => go((index ?? 0) - 1)}
            className={cn(controlClasses, "left-3 top-1/2 -translate-y-1/2")}
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => go((index ?? 0) + 1)}
            className={cn(controlClasses, "right-3 top-1/2 -translate-y-1/2")}
          >
            <ChevronRight className="size-5" aria-hidden="true" />
          </button>
          <DialogPrimitive.Close
            aria-label="Close photo viewer"
            className={cn(controlClasses, "right-3 top-3")}
          >
            <X className="size-5" aria-hidden="true" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
