"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type RevealTag =
  | "div"
  | "section"
  | "article"
  | "aside"
  | "header"
  | "footer"
  | "ul"
  | "li"
  | "p";

interface RevealProps extends React.HTMLAttributes<HTMLElement> {
  /**
   * Rendered element — semantic tag of the block being revealed.
   * Defaults to `div`.
   */
  as?: RevealTag;
}

/**
 * Shared scroll-reveal primitive (Issue #164) — the site's single
 * scroll-triggered motion pattern. Content fades/rises into place once it
 * enters the viewport (`scroll-fade-in` → `fade-in-visible` in globals.css).
 *
 * Reveals are one-shot and never block interaction: the element stays in the
 * SSR'd document from first paint, and reduced-motion sessions skip straight
 * to the visible state (no movement, no wait).
 */
export function Reveal({
  as = "div",
  className,
  children,
  ...rest
}: RevealProps) {
  // Typed as "div" for JSX/ref typing; renders the `as` tag at runtime.
  const Tag = as as "div";
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("fade-in-visible");
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("fade-in-visible");
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -8% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={cn("scroll-fade-in", className)} {...rest}>
      {children}
    </Tag>
  );
}
