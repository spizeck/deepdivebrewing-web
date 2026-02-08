import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-stone">
      <div className="mx-auto max-w-300 px-6 py-12 md:py-16">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <p className="font-semibold text-ink">Deep Dive Brewing Co</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Craft beer, brewed on Saba.
            </p>
          </div>

          <div>
            <p className="text-sm font-semibold text-ink">Explore</p>
            <ul className="mt-3 space-y-2">
              <FooterLink href="/beers">Our Beers</FooterLink>
              <FooterLink href="/where-to-buy">Where to Buy</FooterLink>
            </ul>
          </div>

          <div>
            <p className="text-sm font-semibold text-ink">Company</p>
            <ul className="mt-3 space-y-2">
              <FooterLink href="/about">About</FooterLink>
              <FooterLink href="/contact">Contact</FooterLink>
              <FooterLink href="/trade">Trade</FooterLink>
            </ul>
          </div>

          <div>
            <p className="text-sm font-semibold text-ink">Legal</p>
            <ul className="mt-3 space-y-2">
              {/* TODO: Add legal/policy pages when created */}
              <li className="text-sm text-muted-foreground">
                &copy; {new Date().getFullYear()} Deep Dive Brewing Co
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="text-sm text-muted-foreground transition-opacity duration-200 hover:opacity-85"
      >
        {children}
      </Link>
    </li>
  );
}
