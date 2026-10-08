"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { cn, pressableClasses } from "@/lib/utils";

const navLinks = [
  { href: "/beers", label: "Beers" },
  { href: "/where-to-buy", label: "Where to Buy" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/trade", label: "Trade" },
];

// How far down the page the nav must be before it may retreat, and how much
// scroll-delta counts as an intentional direction change. The delta gate is
// the hysteresis that keeps touch/elastic scrolling from flickering the bar.
const RETREAT_SCROLL_THRESHOLD = 120;
const SCROLL_DELTA_THRESHOLD = 8;

/**
 * Floating pill navigation (Issue #162) — one shared dark-ink pill on every
 * route. It detaches from the viewport edge so hero photography shows around
 * it, and treats the hoppy turtle as the brand anchor.
 *
 * Scroll behavior (Issue #163): the pill retreats above the viewport on a
 * downward scroll past a threshold and returns on the first upward scroll.
 * An open mobile menu pins the pill in place so menu state and header state
 * never fight, and keyboard focus anywhere inside the header forces it back
 * into view. Transforms are the only animated property and run under
 * `motion-safe:`, so reduced-motion sessions get an instant snap instead.
 *
 * The mobile menu is a floating panel below the pill, not an expansion of
 * it: the shell keeps its geometry while the panel reveals and dismisses
 * as one object. Escape closes and returns focus to the toggle, outside
 * presses dismiss it, and navigation closes it.
 */
export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const openRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // The scroll listener reads menu state via a ref so it can be registered
  // once instead of re-attaching on every menu toggle.
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  // A client-side navigation while the menu is open closes it — derived
  // during render (the adjust-state-when-a-value-changes pattern) rather
  // than in an effect.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  // Scroll-aware retreat/restore. rAF-batched, passive listener, hysteresis
  // via a minimum direction-change delta so direction reversals at the same
  // spot (rubber-banding) never flicker the bar.
  useEffect(() => {
    let lastY = window.scrollY;
    let frame = 0;

    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        const dy = y - lastY;
        // Only commit the baseline once the accumulated movement crosses
        // the threshold — otherwise dy is a per-frame delta and a slow
        // 1-2px/frame scroll never registers at all.
        if (Math.abs(dy) > SCROLL_DELTA_THRESHOLD) lastY = y;
        // A control focused inside the header keeps it revealed — retreating
        // here would move the focus-visible outline off-screen.
        if (containerRef.current?.contains(document.activeElement)) {
          setHidden(false);
          return;
        }
        setHidden((prev) => {
          if (openRef.current) return false;
          if (y <= RETREAT_SCROLL_THRESHOLD) return false;
          if (dy > SCROLL_DELTA_THRESHOLD) return true;
          if (dy < -SCROLL_DELTA_THRESHOLD) return false;
          return prev;
        });
      });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // While the menu is open: Escape dismisses and restores focus to the
  // toggle; Tab/Shift+Tab cycle within the pill so focus cannot escape to
  // page content behind the open menu; a press outside the pill dismisses it.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !containerRef.current) return;

      const focusables = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.getClientRects().length > 0);
      if (focusables.length < 2) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    // The mobile menu unrenders at the lg breakpoint; an open state that
    // survives into desktop widths would keep trapping Tab inside the nav
    // with no menu visible, so close it as the viewport widens.
    const desktopMedia = window.matchMedia("(min-width: 64rem)");
    function onDesktopChange(event: MediaQueryListEvent) {
      if (event.matches) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    desktopMedia.addEventListener("change", onDesktopChange);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      desktopMedia.removeEventListener("change", onDesktopChange);
    };
  }, [open]);

  return (
    <header
      // Keyboard focus reaching a link inside a retreated nav reveals it
      // rather than leaving focus on an off-screen control.
      onFocusCapture={() => setHidden(false)}
      className={cn(
        "fixed inset-x-0 top-0 z-50 px-2 pt-[calc(1rem+env(safe-area-inset-top))] min-[400px]:px-3 sm:px-5",
        "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out",
        hidden && "-translate-y-[calc(100%+1.5rem)]"
      )}
    >
      {/* Anchors the floating mobile panel to the pill's box so the shell
          itself never has to grow to host the open menu. */}
      <div
        ref={containerRef}
        className={cn(
          "relative mx-auto max-w-3xl rounded-full border border-paper/15 bg-ink/85 shadow-[0_1px_3px_rgba(11,15,20,0.35)] backdrop-blur-md",
          "lg:flex lg:w-full lg:max-w-300 lg:items-center lg:justify-between lg:gap-6 lg:border-0 lg:bg-transparent lg:px-6 lg:shadow-none lg:backdrop-blur-none"
        )}
      >
        {/* Narrow padding scale below 400px keeps the pill's inset and the
            brand/toggle row from colliding. At lg the row itself becomes
            the floating brand pill; the link list floats separately. On
            desktop the hero already carries the full wordmark, so the
            brand pill compacts to the turtle mark alone — the text stays
            mounted as sr-only so the link keeps its accessible name. */}
        <div className="flex h-14 items-center justify-between gap-1.5 pl-3.5 pr-1.5 min-[400px]:gap-2 min-[400px]:pl-4 min-[400px]:pr-2 sm:gap-3 sm:pl-5 sm:pr-2.5 lg:h-13 lg:rounded-full lg:border lg:border-paper/15 lg:bg-ink/85 lg:px-4 lg:shadow-[0_1px_3px_rgba(11,15,20,0.35)] lg:backdrop-blur-md">
          <Link
            href="/"
            // Selecting a link to the current route never changes
            // pathname, so close the menu on selection too.
            onClick={() => setOpen(false)}
            className="flex h-11 items-center gap-2 whitespace-nowrap rounded-full pr-2 font-festival text-[clamp(0.9rem,calc(6vw-0.3rem),1.25rem)] leading-7 tracking-wide text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/80 sm:text-2xl lg:w-11 lg:justify-center lg:pr-0"
          >
            <BrandMark tone="white" size={30} decorative />
            {/* Festival's metrics sit the baseline high in the 28px line
                box, so the glyph ink lands ~4.5px above box-center —
                0.25em lowers the wordmark's ink onto the mark's optical
                center. The span hides at lg where the pill is mark-only. */}
            <span className="inline-block translate-y-[0.25em] lg:sr-only">
              Deep Dive Brewing Co
            </span>
          </Link>

          {/* The button keeps a 44px target and focus ring while the icon
              sits bare on the pill — a persistent disc surface read as a
              button-in-a-button and its lighter fill mismatched the pill.
              The span only paints as interaction feedback (press, and
              hover on devices that can hover — plain group-hover is not
              gated to hover-capable devices, so on touch a tap would
              leave :hover stuck on the element and keep the fill lit). */}
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={menuId}
            className={cn(
              "group flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/80 lg:hidden",
              pressableClasses
            )}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-150 group-active:bg-paper/15 [@media(hover:hover)]:group-hover:bg-paper/10">
              <span className="relative block h-4.5 w-4.5">
                <Menu
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 h-4.5 w-4.5 motion-safe:transition-all motion-safe:duration-200",
                    open ? "rotate-90 opacity-0" : "rotate-0 opacity-100"
                  )}
                />
                <X
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 h-4.5 w-4.5 motion-safe:transition-all motion-safe:duration-200",
                    open ? "rotate-0 opacity-100" : "-rotate-90 opacity-0"
                  )}
                />
              </span>
            </span>
          </button>
        </div>

        {/* Desktop nav floats as its own pill on the opposite end of the
            content column, so the wordmark and links stop competing for
            one long strip. */}
        <nav
          aria-label="Main"
          className="hidden h-13 items-center gap-1 rounded-full border border-paper/15 bg-ink/85 px-1 shadow-[0_1px_3px_rgba(11,15,20,0.35)] backdrop-blur-md lg:flex"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? "page" : undefined}
              className={cn(
                "whitespace-nowrap rounded-full px-3.5 py-3 text-sm font-medium transition-colors duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/80",
                isActive(link.href)
                  ? "bg-paper/15 text-paper"
                  : "text-paper/75 hover:bg-paper/10 hover:text-paper active:bg-paper/15"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Mobile nav — a separate floating surface below the pill, not an
            expansion of it. The shell keeps its geometry; the panel reveals
            as one object with a 2px settle while opacity only softens the
            move (0.92→1 in, 1→0.92 out) — it never fades from nothing, and
            the close reads as a dismissal rather than a retreat upward. The
            material itself (ink/border/shadow/radius) is constant in both
            states so nothing appears to develop mid-transition;
            `visibility` joins the transition list so the panel hides
            exactly when the exit finishes (discrete flip at the end on
            close, at the start on open) instead of fading to transparent.
            The body is solid ink (vs the pill's 85%): translucency
            reads attractively over the hero photo, but an open menu
            over a light interior page kept the page's own headings
            legible through the panel even at 98-99% ink — solid is
            the only value that fully silences the copy behind it.
            Always mounted so the same transition runs in
            reverse on close;
            inert + pointer-events-none keep the hidden panel out of the
            tab order and out from under taps. The scrollable region is
            bounded by the viewport minus the pill's top offset + bar so
            the last link stays reachable on very short viewports. */}
        <nav
          id={menuId}
          aria-label="Mobile"
          inert={!open}
          className={cn(
            // -inset-x-px aligns the panel's painted edges with the pill's
            // border box rather than its (1px-inset) padding box.
            "absolute -inset-x-px top-full mt-2 max-h-[calc(100dvh_-_7rem_-_env(safe-area-inset-top))] overflow-y-auto rounded-3xl border border-paper/15 bg-ink shadow-[0_1px_3px_rgba(11,15,20,0.35)] backdrop-blur-md",
            "motion-safe:transition-[opacity,translate,visibility] motion-safe:ease-out lg:hidden",
            open
              ? "visible translate-y-0 opacity-100 motion-safe:duration-[180ms]"
              : "invisible pointer-events-none -translate-y-0.5 opacity-[0.92] motion-safe:duration-[140ms]"
          )}
        >
          {/* Contiguous min-h rows keep the menu dense while every link
              retains a comfortable tap target. */}
          <div className="flex flex-col px-2 py-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                // Selecting the current route never changes pathname,
                // so close the menu on selection too.
                onClick={() => setOpen(false)}
                aria-current={isActive(link.href) ? "page" : undefined}
                className={cn(
                  "flex min-h-[48px] items-center rounded-xl px-4 text-base font-medium transition-colors duration-150",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/80",
                  isActive(link.href)
                    ? "bg-paper/15 text-paper"
                    : "text-paper/85 hover:bg-paper/10 hover:text-paper active:bg-paper/15"
                )}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}
