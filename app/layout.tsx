import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { SiteFooter } from "@/components/site-footer";
import { AnalyticsClickTracker } from "@/components/analytics-click-tracker";
import { PageViewTracker } from "@/components/page-view-tracker";
import { GtmBootstrap } from "@/components/gtm-bootstrap";
import { ConsentManager } from "@/components/consent-manager";
import { AdminAnalyticsGuard } from "@/components/admin-analytics-guard";
import { siteUrl } from "@/lib/site";
import "./globals.css";

// Marketing analytics is delivered by Google Tag Manager → GA4. The GTM
// container ID is operator configuration (NEXT_PUBLIC_GTM_ID); there is no
// default because a container must be created and configured first — see
// docs/operations/analytics.md. GTM ships only in Vercel production builds
// with a configured ID: VERCEL_ENV is "preview" on preview deployments and
// unset locally/in CI, so tests, local dev, and previews can never reach the
// production property.
const gtmId = process.env.NEXT_PUBLIC_GTM_ID;
const analyticsEnabled = process.env.VERCEL_ENV === "production" && !!gtmId;
// The consent layer is bundled Klaro — no vendor ID or hosted CMP service.
// ConsentManager loads it from the application bundle on public pages in
// every environment; the Consent Mode defaults it acts on are emitted by
// GtmBootstrap only in production (where GTM exists to consume them).

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Deep Dive Brewing Co",
    template: "%s | Deep Dive Brewing Co",
  },
  description:
    "Craft beer from Deep Dive Brewing Co. Explore our beers, find where to buy, and connect with us.",
  keywords: [
    "Deep Dive Brewing",
    "Saba brewery",
    "craft beer Saba",
    "Caribbean craft beer",
    "where to buy beer on Saba",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Deep Dive Brewing Co",
    title: "Deep Dive Brewing Co",
    description:
      "Craft beer from Deep Dive Brewing Co. Explore our beers, find where to buy, and connect with us.",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co",
      },
    ],
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Deep Dive Brewing Co",
    description:
      "Craft beer from Deep Dive Brewing Co. Explore our beers, find where to buy, and connect with us.",
    images: ["/photos/og-default.jpg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0B0F14",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        {/* Renders unconditionally: a client-side transition into /admin*
            from a GTM-carrying public page must force a document load so no
            live container survives inside admin. */}
        <AdminAnalyticsGuard />
        {/* GtmBootstrap must mount before the trackers: its inline script
            pushes the Consent Mode defaults, and every dataLayer entry that
            follows (page_view first among them) must queue after those
            defaults so the Google tag never sees an event pre-consent. */}
        {analyticsEnabled && <GtmBootstrap gtmId={gtmId!} />}
        {/* Bundled Klaro consent UI — loads on public pages in every
            environment, never on /admin*. It governs only the Consent
            Mode signals the bootstrap already defaulted to denied. */}
        <ConsentManager />
        <AnalyticsClickTracker />
        <PageViewTracker />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-paper"
        >
          Skip to content
        </a>
        {children}
        <SiteFooter />
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
