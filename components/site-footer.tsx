import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-stone">
      <div className="mx-auto max-w-300 px-6 py-12 md:py-16">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-semibold text-ink">Deep Dive Brewing Co</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Craft beer, brewed on Saba.
            </p>
            <div className="mt-4 flex gap-4">
              <a
                href="https://www.facebook.com/deepdivebrewing"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-opacity duration-200 hover:opacity-85"
                aria-label="Facebook"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                </svg>
              </a>
              <a
                href="https://www.instagram.com/deepdivebrewing"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-opacity duration-200 hover:opacity-85"
                aria-label="Instagram"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zM5.838 12a6.162 6.162 0 1 1 12.324 0 6.162 6.162 0 0 1-12.324 0zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm4.965-10.405a1.44 1.44 0 1 1 2.881.001 1.44 1.44 0 0 1-2.881-.001z" />
                </svg>
              </a>

              <a
                href="https://untappd.com/DeepDiveBrewingCo"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-opacity duration-200 hover:opacity-85"
                aria-label="Untappd"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 640 640"
                  fill="currentColor"
                >
                  <path d="M401.5 113.9C321.7 274 316.9 266.4 313.6 287.1L308.4 319.9C306.5 331.9 301.8 343.4 294.7 353.3L145.8 561.1C138.2 571.7 125.4 577.3 112.4 575.7C72.1 570.7 34.6 543.5 17.1 507.2C11.4 495.4 12.6 481.4 20.2 470.8L169.1 262.9C176.2 253 185.5 244.9 196.3 239.2L225.6 223.7C244.1 213.9 235.3 211.8 361.2 84.8C362.2 80 362.2 77.5 364.8 76.8C367.8 76.1 371.4 75.8 371.1 72.2L370.7 67.6C370.5 65.7 372 64 373.9 64C378.4 63.9 387.1 65.2 399.5 74C411.8 82.9 415.9 90.8 417.2 95.1C417.8 96.9 416.6 98.8 414.8 99.3L410.3 100.4C406.9 101.3 407.8 104.8 408 107.8C408.1 110.6 405.7 111.4 401.5 113.9zM230.3 100.4C233.7 101.3 232.8 104.8 232.6 107.8C232.4 110.5 234.7 111.3 239 113.8C246.9 129.7 254.3 144.3 261.2 157.8C261.9 159.1 263.5 159.3 264.5 158.3C275.7 146.3 289.1 132.1 305 115.7C306.3 114.3 306.4 112.2 305.1 110.8C297.1 102.6 288.6 93.9 279.5 84.7C278.5 80 278.5 77.4 275.9 76.7C272.9 75.9 269.3 75.7 269.6 72.1C269.9 68.8 271 64 266.8 63.9C262.3 63.8 253.6 65 241.2 73.9C228.9 82.8 224.8 90.7 223.5 95C222.1 99.2 227.1 99.6 230.3 100.4zM620.2 470.7L471.4 262.8C458.2 244.3 444.8 239.4 415 223.7C403.8 217.8 400.8 212.8 384.5 194.8C383.5 193.7 381.6 193.9 380.9 195.3C334.6 284.1 333.8 278.1 331.9 290.1C330.2 300.8 330.6 310.1 332.2 319.9C334.1 331.9 338.8 343.4 345.9 353.3L494.8 561.2C502.4 571.8 515 577.4 527.9 575.9C568.2 571 605.9 543.9 623.6 507.3C629 495.4 627.9 481.4 620.2 470.7z" />
                </svg>
              </a>
            </div>
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
