"use client";

import { useState } from "react";
import Link from "next/link";

const navLinks = [
  { href: "/beers", label: "Beers" },
  { href: "/where-to-buy", label: "Where to Buy" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/trade", label: "Trade" },
];

interface MobileMenuProps {
  variant?: "light" | "dark";
}

export function MobileMenu({ variant = "dark" }: MobileMenuProps) {
  const [open, setOpen] = useState(false);

  const iconColor = variant === "light" ? "text-paper" : "text-ink";

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center ${iconColor}`}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        {open ? (
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
            <line x1="18" x2="6" y1="6" y2="18" />
            <line x1="6" x2="18" y1="6" y2="18" />
          </svg>
        ) : (
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
        )}
      </button>

      {open && (
        <nav className="absolute left-0 right-0 top-full z-50 border-b border-stone bg-ink/95 backdrop-blur-md px-6 py-6">
          <div className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="text-base font-medium text-paper/90 transition-opacity duration-200 hover:opacity-100"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
