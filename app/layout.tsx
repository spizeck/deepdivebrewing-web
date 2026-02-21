import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";
const gaId = process.env.NEXT_PUBLIC_GA_ID ?? "G-5VBQTMP37H";

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
        url: "/photos/herograin.jpg",
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
    images: ["/photos/herograin.jpg"],
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
        {children}
        <SiteFooter />
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
          strategy="lazyOnload"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${gaId}');
          `}
        </Script>
      </body>
    </html>
  );
}
