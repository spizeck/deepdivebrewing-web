import Image from "next/image";

// Deep Dive Brewing hoppy turtle — the primary brand mark. Monochrome
// only: the black file for light surfaces, the white file for dark
// surfaces. Never recolor; the two supplied assets are the whole palette.
// See THEME_AND_BRANDING.md.
const MARKS = {
  black: "/brand/email-mark-black.png",
  white: "/brand/email-mark-white.png",
} as const;

// Natural size of the supplied mark files — next/image keeps the 600:503
// aspect so any rendered width stays undistorted.
const MARK_WIDTH = 600;
const MARK_HEIGHT = 503;

export interface BrandMarkProps {
  // Which artwork file: "black" on light backgrounds, "white" on dark.
  tone: "black" | "white";
  // Rendered width in CSS pixels; height follows the mark's aspect ratio.
  size?: number;
  // True when adjacent text already names the brand — renders alt="" so
  // the mark is skipped by assistive tech instead of doubling the name.
  decorative?: boolean;
  className?: string;
}

export function BrandMark({
  tone,
  size = 32,
  decorative = false,
  className,
}: BrandMarkProps) {
  return (
    <Image
      src={MARKS[tone]}
      width={MARK_WIDTH}
      height={MARK_HEIGHT}
      sizes={`${size}px`}
      alt={decorative ? "" : "Deep Dive Brewing Co"}
      aria-hidden={decorative || undefined}
      className={className}
      style={{ width: size, height: "auto" }}
    />
  );
}
