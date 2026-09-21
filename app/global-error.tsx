"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Root-layout error boundary (Issue #92): replaces the whole document when
// the root layout itself fails, so it must render its own <html>/<body> and
// cannot reuse site chrome. Reports the error to Sentry — the last resort
// capture point for failures onRequestError and error.tsx cannot reach.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      extra: { digest: error.digest ?? null },
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p>The page could not be loaded. Please try again.</p>
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
