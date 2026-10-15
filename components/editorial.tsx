import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Editorial primitives for long-form story pages (Issue #192). Deliberately
 * small: a section intro, a wide captioned figure, a photo/text split, and a
 * numbered process list: the recurring shapes of feature pages, not a
 * page-builder. All are server components; wrap them in <Reveal> from the
 * page where a scroll reveal is wanted.
 */

const figureCaptionClass = "mt-3 text-sm text-muted-foreground";

interface SectionIntroProps {
  /** Small uppercase kicker above the heading (e.g. "The Island"). */
  eyebrow?: string;
  title: string;
  /** Optional lede paragraph under the heading. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Section opener: eyebrow + h2 + optional lede, capped at reading width.
 */
export function SectionIntro({
  eyebrow,
  title,
  children,
  className,
}: SectionIntroProps) {
  return (
    <div className={cn("max-w-180", className)}>
      {eyebrow && (
        <p className="text-xs font-semibold uppercase tracking-wider text-moss">
          {eyebrow}
        </p>
      )}
      <h2 className="mt-2 text-3xl font-bold tracking-tight">{title}</h2>
      {children && <div className="mt-4 text-muted-foreground">{children}</div>}
    </div>
  );
}

interface EditorialFigureProps {
  src: string;
  alt: string;
  caption?: string;
  /** Reserve for the page's likely LCP image only. */
  priority?: boolean;
  className?: string;
}

/**
 * Full-content-width photo with a caption. The 4:3 mobile crop keeps subject
 * matter in frame; the 2:1 banner on wider screens matches the beer-detail
 * hero rhythm.
 */
export function EditorialFigure({
  src,
  alt,
  caption,
  priority,
  className,
}: EditorialFigureProps) {
  return (
    <figure className={className}>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-stone/50 sm:aspect-[2/1]">
        <Image
          src={src}
          alt={alt}
          fill
          priority={priority}
          quality={75}
          sizes="(max-width: 1200px) 100vw, 1200px"
          className="object-cover"
        />
      </div>
      {caption && (
        <figcaption className={figureCaptionClass}>{caption}</figcaption>
      )}
    </figure>
  );
}

interface EditorialSplitProps {
  src: string;
  alt: string;
  caption?: string;
  /** Put the photo on the right at the md breakpoint and up. */
  reverse?: boolean;
  /** 3:4 frame for tall shots; default is a 4:3 landscape frame. */
  portrait?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Photo/text split for editorial rhythm: image beside prose at md+, stacked
 * (photo first) on mobile. Order stays photo-then-text in the document so the
 * reading order is consistent regardless of the visual `reverse` flip.
 */
export function EditorialSplit({
  src,
  alt,
  caption,
  reverse,
  portrait,
  children,
  className,
}: EditorialSplitProps) {
  return (
    <div
      className={cn(
        "grid items-center gap-8 md:grid-cols-2 md:gap-12",
        className
      )}
    >
      <figure className={cn(reverse && "md:order-2")}>
        <div
          className={cn(
            "relative w-full overflow-hidden rounded-lg bg-stone/50",
            portrait ? "aspect-[3/4]" : "aspect-[4/3]"
          )}
        >
          <Image
            src={src}
            alt={alt}
            fill
            quality={75}
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 600px"
            className="object-cover"
          />
        </div>
        {caption && (
          <figcaption className={figureCaptionClass}>{caption}</figcaption>
        )}
      </figure>
      <div className="max-w-140">{children}</div>
    </div>
  );
}

/**
 * Ordered process list: top/bottom rules with per-step dividers rather than
 * cards. The numeral is decorative (`ol` semantics carry the count).
 */
export function ProcessSteps({ children }: { children: React.ReactNode }) {
  return (
    <ol className="divide-y divide-stone border-y border-stone">
      {children}
    </ol>
  );
}

interface ProcessStepProps {
  /** Display numeral, e.g. "01". */
  step: string;
  title: string;
  children: React.ReactNode;
}

export function ProcessStep({ step, title, children }: ProcessStepProps) {
  return (
    <li className="grid gap-1 py-6 sm:grid-cols-[3rem_1fr] sm:gap-6">
      <span
        aria-hidden="true"
        className="text-sm font-semibold tabular-nums text-moss"
      >
        {step}
      </span>
      <div>
        <h3 className="font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}
