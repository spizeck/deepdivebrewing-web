import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderDefault } from "@/components/site-header-default";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page Not Found",
  robots: { index: false },
};

// Root not-found boundary. notFound() from any segment renders here inside
// the root layout, so the site header is included explicitly (the (pages)
// group layout does not wrap this file).
export default function NotFound() {
  return (
    <>
      <SiteHeaderDefault />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-300 px-6 pb-20 pt-15 text-center md:pb-30"
      >
        <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          404
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">
          This page could not be found
        </h1>
        <p className="mx-auto mt-3 max-w-180 text-muted-foreground">
          The link may be outdated or the page may have moved.
        </p>
        <Button asChild className="mt-8 h-11 min-h-[44px] px-6">
          <Link href="/">Back to homepage</Link>
        </Button>
      </main>
    </>
  );
}
