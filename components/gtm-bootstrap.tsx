"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";
import { buildGtmInitScript } from "@/lib/consent";

// Marketing analytics is excluded from admin surfaces. Rendered only when
// the production gate in app/layout.tsx passes (VERCEL_ENV=production AND a
// configured container ID); this pathname check keeps the container off
// documents that BEGIN on /admin* — preferable to loading GTM and filtering
// downstream, since an absent container can collect nothing. It cannot help
// a document that loaded GTM on a public page and then client-navigated into
// /admin* (returning null does not unload an already-loaded script): that
// transition is closed by AdminAnalyticsGuard, which forces a full document
// load on entry so the fresh admin document boots without GTM.
//
// Consent (Cookiebot CMP + Google Consent Mode v2, when NEXT_PUBLIC_COOKIEBOT_ID
// is configured): the init script pushes `consent default` denied signals onto
// dataLayer BEFORE `gtm.start`, so the consent state exists before any Google
// tag can evaluate. uc.js collects the visitor's choice and fires `consent
// update` commands. `data-blockingmode="none"` is deliberate: Cookiebot must
// not auto-block scripts — Consent Mode governs the Google tags at the data
// layer and there are no other trackers to block, so auto-blocking could only
// interfere (GTM, Vercel scripts, navigation). The same pathname gate keeps
// the CMP off /admin* documents — they carry no marketing analytics, so
// there is nothing to consent to. No CMP renders when the ID is unconfigured
// — an absent integration, not a broken one.
export function GtmBootstrap({
  gtmId,
  cookiebotId,
}: {
  gtmId: string;
  cookiebotId?: string;
}) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return (
    <>
      <Script id="gtm-init" strategy="afterInteractive">
        {buildGtmInitScript(cookiebotId)}
      </Script>
      {cookiebotId && (
        <Script
          id="Cookiebot"
          strategy="afterInteractive"
          src="https://consent.cookiebot.com/uc.js"
          data-cbid={cookiebotId}
          data-blockingmode="none"
        />
      )}
      <Script
        id="gtm"
        strategy="lazyOnload"
        src={`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`}
      />
    </>
  );
}
