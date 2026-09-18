"use client";

import { documentHasMarketingContainer } from "@/lib/analytics";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

// The Navigation API is not yet in TypeScript's DOM lib — only the surface
// this guard uses is declared here.
interface NavigationEventLike {
  navigationType: string;
  cancelable: boolean;
  destination: { url: string; sameDocument: boolean };
  preventDefault: () => void;
}

interface NavigationLike {
  addEventListener?: (
    type: string,
    listener: (event: NavigationEventLike) => void,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event: NavigationEventLike) => void,
  ) => void;
}

function isAdminUrl(url: string): boolean {
  return new URL(url, window.location.origin).pathname.startsWith("/admin");
}

/**
 * The root layout persists across App Router client navigations, so a GTM
 * container loaded on a public page would stay active after a client-side
 * transition into `/admin*` — a loaded script cannot be unloaded, and
 * refusing dataLayer pushes only stops the application's own events, not
 * the container's automatic collection. Entry into `/admin*` is therefore
 * turned into a full document navigation whenever this document carries a
 * marketing container: the fresh document boots without GTM
 * (`GtmBootstrap` renders nothing on `/admin*`), restoring the "no
 * marketing analytics on admin" guarantee. Without a live container this
 * is a no-op, so direct admin entry and all public browsing are
 * unaffected.
 */
export function AdminAnalyticsGuard() {
  const pathname = usePathname();

  useEffect(() => {
    // Once the boundary has decided on a document load, later signals (the
    // navigation it triggers included) must not re-trigger it.
    let leaving = false;
    const navigation = (
      window as Window & { navigation?: NavigationLike }
    ).navigation;

    // Fallback for browsers without the Navigation API, and for any
    // transition that still manages to commit: if the URL is already on
    // /admin* and this document carries a container, reload the document.
    const enforce = () => {
      if (leaving) return;
      if (
        isAdminUrl(window.location.href) &&
        documentHasMarketingContainer()
      ) {
        leaving = true;
        window.location.reload();
      }
    };

    // Primary path where the Navigation API exists (Chromium): veto a
    // same-document navigation into /admin* and load the admin document
    // instead — the transition becomes a hard navigation rather than
    // racing one afterwards.
    const onNavigate = (event: NavigationEventLike) => {
      if (
        leaving ||
        !event.destination.sameDocument ||
        !isAdminUrl(event.destination.url) ||
        !documentHasMarketingContainer()
      ) {
        return;
      }
      leaving = true;
      try {
        if (event.cancelable) event.preventDefault();
      } catch {
        // If the navigation cannot be vetoed, the URL commits and the
        // post-commit fallback above still forces the document load.
        leaving = false;
        return;
      }
      window.location.assign(event.destination.url);
    };

    enforce();
    window.addEventListener("popstate", enforce);
    navigation?.addEventListener?.("navigate", onNavigate);
    return () => {
      window.removeEventListener("popstate", enforce);
      navigation?.removeEventListener?.("navigate", onNavigate);
    };
  }, [pathname]);

  return null;
}
