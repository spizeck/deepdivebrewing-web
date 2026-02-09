import Link from "next/link";
import { MobileMenu } from "@/components/mobile-menu";

const navLinks = [
  { href: "/beers", label: "Beers" },
  { href: "/where-to-buy", label: "Where to Buy" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/trade", label: "Trade" },
];

export function SiteHeaderDefault() {
  return (
    <header className="relative border-b border-stone bg-paper">
      <div className="mx-auto flex max-w-300 items-center justify-between px-6 py-4">
        <Link href="/" className="text-xl font-semibold tracking-tight text-ink">
          Deep Dive Brewing Co
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-ink/70 transition-opacity duration-200 hover:opacity-85"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <MobileMenu variant="dark" />
      </div>
    </header>
  );
}
