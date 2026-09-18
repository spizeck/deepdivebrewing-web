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
// Consent (bundled Klaro + Google Consent Mode v2): the init script pushes
// `consent default` denied signals onto dataLayer BEFORE `gtm.start`, so the
// consent state exists before any Google tag can evaluate. The ConsentManager
// component then loads Klaro from the application bundle and fires `consent
// update` commands from the visitor's stored choice or banner interaction.
// The same pathname gate keeps consent initialization off /admin* documents
// — they carry no marketing analytics, so there is nothing to consent to.
export function GtmBootstrap({ gtmId }: { gtmId: string }) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return (
    <>
      <Script id="gtm-init" strategy="afterInteractive">
        {buildGtmInitScript()}
      </Script>
      <Script
        id="gtm"
        strategy="lazyOnload"
        src={`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`}
      />
    </>
  );
}
