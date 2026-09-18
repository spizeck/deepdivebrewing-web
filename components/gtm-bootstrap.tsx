"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";

// Marketing analytics is excluded from admin surfaces. Rendered only when
// the production gate in app/layout.tsx passes (VERCEL_ENV=production AND a
// configured container ID); this pathname check additionally keeps the
// container off /admin and /admin-fixture entirely — preferable to loading
// GTM and filtering downstream, since it guarantees no container-side
// automatic collection on admin routes.
export function GtmBootstrap({ gtmId }: { gtmId: string }) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return (
    <>
      <Script id="gtm-init" strategy="afterInteractive">
        {`(window.dataLayer=window.dataLayer||[]).push({'gtm.start':Date.now(),event:'gtm.js'});`}
      </Script>
      <Script
        id="gtm"
        strategy="lazyOnload"
        src={`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`}
      />
    </>
  );
}
