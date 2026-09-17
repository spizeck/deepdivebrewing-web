"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { sendPageView } from "@/lib/analytics";

/**
 * Emits a GA4 page_view on App Router client-side navigations.
 * The landing page view is sent by `gtag('config', …)` — this skips the
 * first render to avoid double-counting it. Admin surfaces are excluded:
 * admin activity belongs to application audit logs, not marketing analytics.
 */
export function PageViewTracker() {
  const pathname = usePathname();
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (pathname.startsWith("/admin")) return;
    sendPageView(pathname + window.location.search);
  }, [pathname]);

  return null;
}
