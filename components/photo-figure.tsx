import Image from "next/image";
import { Expand } from "lucide-react";
import { cn, pressableClasses } from "@/lib/utils";
import type { BreweryPhoto } from "@/lib/brewery-photos";

interface PhotoFigureProps {
  photo: BreweryPhoto;
  /**
   * Aspect-ratio class controlling the editorial crop, e.g.
   * "aspect-[16/9]". The image fills the box with object-cover, so this
   * is where the composition is decided.
   */
  aspectClass: string;
  /** Accurate sizes hint for next/image — required. */
  sizes: string;
  /** Extra classes on the <figure> (grid placement, margins). */
  className?: string;
  /** Extra classes on the <img> — e.g. object-position for the crop. */
  imageClassName?: string;
  captionClassName?: string;
  showCaption?: boolean;
  /**
   * When provided, the image becomes an enlarge trigger: an accessible
   * button labelled "Enlarge photo: <alt>" with a persistent expand
   * affordance, wired to the shared PhotoLightbox. The click event is
   * forwarded so callers can capture the trigger for focus restore.
   */
  onEnlarge?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Editorial image block (Issue #193): a <figure> with an aspect-cropped
 * next/image and a restrained caption. Server-safe — it only becomes
 * interactive when a client parent passes onEnlarge.
 */
export function PhotoFigure({
  photo,
  aspectClass,
  sizes,
  className,
  imageClassName,
  captionClassName,
  showCaption = true,
  onEnlarge,
}: PhotoFigureProps) {
  const mediaBox = cn(
    "relative w-full overflow-hidden rounded-lg bg-stone/50",
    aspectClass
  );

  return (
    <figure className={className}>
      {onEnlarge ? (
        <button
          type="button"
          onClick={onEnlarge}
          aria-label={`Enlarge photo: ${photo.alt}`}
          className={cn(
            mediaBox,
            "group block cursor-zoom-in",
            pressableClasses
          )}
        >
          {/* The button's aria-label carries the description, so the
              image stays decorative inside it (no duplicated name). */}
          <Image
            src={photo.src}
            alt=""
            fill
            sizes={sizes}
            className={cn("object-cover", imageClassName)}
          />
          <span
            aria-hidden="true"
            className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-md bg-ink/55 text-paper opacity-80 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Expand className="size-4" />
          </span>
        </button>
      ) : (
        <div className={mediaBox}>
          <Image
            src={photo.src}
            alt={photo.alt}
            fill
            sizes={sizes}
            className={cn("object-cover", imageClassName)}
          />
        </div>
      )}
      {showCaption ? (
        <figcaption
          className={cn("mt-2 text-sm text-muted-foreground", captionClassName)}
        >
          {photo.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
