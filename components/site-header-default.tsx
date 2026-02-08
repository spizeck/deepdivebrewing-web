import Link from "next/link";

const navLinks = [
  { href: "/beers", label: "Beers" },
  { href: "/where-to-buy", label: "Where to Buy" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/trade", label: "Trade" },
];

export function SiteHeaderDefault() {
  return (
    <header className="border-b border-stone bg-paper">
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
        <MobileMenuButton />
      </div>
    </header>
  );
}

function MobileMenuButton() {
  // TODO: Implement mobile menu with state management
  return (
    <button
      className="flex items-center justify-center md:hidden"
      aria-label="Open menu"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="4" x2="20" y1="12" y2="12" />
        <line x1="4" x2="20" y1="6" y2="6" />
        <line x1="4" x2="20" y1="18" y2="18" />
      </svg>
    </button>
  );
}
