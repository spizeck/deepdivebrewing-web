"use client";

import { useEffect } from "react";
import Link from "next/link";
import { SiteHeaderDefault } from "@/components/site-header-default";
import { Button } from "@/components/ui/button";

// Root error boundary: an unhandled render error in any page lands here with
// the site chrome intact instead of the bare framework error screen. The
// digest is logged so a user report can be matched to the server-side entry
// in Vercel logs; nothing sensitive is rendered or logged.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      "Unhandled route error (digest: %s): %s",
      error.digest ?? "none",
      error.message
    );
  }, [error]);

  return (
    <>
      <SiteHeaderDefault />
      <main
        id="main-content"
        className="mx-auto max-w-300 px-6 pb-20 pt-15 text-center md:pb-30"
      >
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Something went wrong
        </h1>
        <p className="mx-auto mt-3 max-w-180 text-muted-foreground">
          The page could not be loaded. Please try again — if it keeps
          happening, let us know via the contact page.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button
            onClick={reset}
            className="h-11 min-h-[44px] px-6"
          >
            Try again
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-11 min-h-[44px] px-6"
          >
            <Link href="/">Back to homepage</Link>
          </Button>
        </div>
      </main>
    </>
  );
}
