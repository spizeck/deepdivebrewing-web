import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { MobileMenu } from "@/components/mobile-menu";

const navLinks = [
  { href: "/beers", label: "Beers" },
  { href: "/where-to-buy", label: "Where to Buy" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/trade", label: "Trade" },
];

export function SiteHeader() {
  return (
    <header className="absolute top-0 left-0 right-0 z-50 border-b border-white/10 backdrop-blur-sm">
      <div className="mx-auto flex max-w-300 items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-sm text-xl font-semibold tracking-tight text-paper focus-visible:outline-paper"
        >
          <BrandMark tone="white" size={30} decorative />
          Deep Dive Brewing Co
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-sm text-sm font-medium text-paper/80 transition-opacity duration-200 hover:opacity-100 focus-visible:outline-paper"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <MobileMenu variant="light" />
      </div>
    </header>
  );
}
