"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { sendPageView } from "@/lib/analytics";

/**
 * Emits a dataLayer page_view for the initial landing AND each App Router
 * client-side navigation — the application owns all page_view generation.
 * The GTM Google tag is configured with send_page_view=false (see
 * docs/operations/analytics.md), so nothing else emits page views and
 * duplication is impossible by construction. Admin surfaces are excluded:
 * admin activity belongs to application audit logs, not marketing
 * analytics (sendPageView also refuses to push on /admin paths).
 */
export function PageViewTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.startsWith("/admin")) return;
    sendPageView(pathname + window.location.search);
  }, [pathname]);

  return null;
}
