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
 * The mobile menu is a disclosure inside the same floating object: the pill
 * opens into a rounded panel (mounted only while open), Escape closes and
 * returns focus to the toggle, outside presses dismiss it, and navigation
 * closes it.
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
      <div
        ref={containerRef}
        className={cn(
          "mx-auto max-w-3xl border border-paper/15 bg-ink/85 shadow-[0_1px_3px_rgba(11,15,20,0.35)] backdrop-blur-md lg:w-fit lg:max-w-none",
          "motion-safe:transition-[border-radius] motion-safe:duration-200",
          open ? "rounded-3xl" : "rounded-full"
        )}
      >
        {/* Narrow padding scale below 400px keeps the pill's inset and the
            brand/toggle row from colliding; lg switches to a compact
            content-sized pill with a shorter profile. */}
        <div className="flex h-14 items-center justify-between gap-1.5 pl-3.5 pr-1.5 min-[400px]:gap-2 min-[400px]:pl-4 min-[400px]:pr-2 sm:gap-3 sm:pl-5 sm:pr-2.5 lg:h-13 lg:gap-6">
          <Link
            href="/"
            className="flex h-11 items-center gap-2 whitespace-nowrap rounded-full pr-2 font-festival text-[clamp(0.9rem,calc(6vw-0.3rem),1.25rem)] leading-7 tracking-wide text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/80 sm:text-2xl"
          >
            <BrandMark tone="white" size={30} decorative />
            Deep Dive Brewing Co
          </Link>

          <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
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

          {/* The button keeps a 44px target and focus ring; the visible
              circle is a smaller, lighter nested disc so the control reads
              as a disclosure affordance instead of a button inside a
              button. Hover/active styling lives on the disc via `group`. */}
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
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-paper/15 bg-paper/5 transition-colors duration-150 group-hover:border-paper/25 group-hover:bg-paper/10 group-active:bg-paper/15">
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

        {open && (
          <nav
            id={menuId}
            aria-label="Mobile"
            className="border-t border-paper/10 px-2 pb-3 pt-2 lg:hidden"
          >
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(link.href) ? "page" : undefined}
                className={cn(
                  "flex min-h-[48px] items-center rounded-xl px-4 text-base font-medium animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/80",
                  isActive(link.href)
                    ? "bg-paper/15 text-paper"
                    : "text-paper/85 hover:bg-paper/10 hover:text-paper active:bg-paper/15"
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}
