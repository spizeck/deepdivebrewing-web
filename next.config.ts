import type { NextConfig } from "next";
import createMDX from "@next/mdx";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";

const longCacheHeaders = [
  {
    key: "Cache-Control",
    value: "public, max-age=31536000, immutable",
  },
];

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 31536000,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
        port: "",
        pathname: "/**",
      },
    ],
  },
  async redirects() {
    return [
      // www → non-www in one hop, permanent 308.
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "www.deepdivebrewing.com",
          },
        ],
        destination: "https://deepdivebrewing.com/:path*",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `connect-src 'self' ${siteUrl} https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://firebasestorage.googleapis.com https://*.firebaseio.com https://*.googleapis.com https://vitals.vercel-insights.com https://va.vercel-scripts.com`,
              "font-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
              "frame-src 'self' https://www.google.com https://www.youtube.com https://www.youtube-nocookie.com",
              "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://*.googleusercontent.com https://*.google-analytics.com https://*.googletagmanager.com https://*.gstatic.com https://va.vercel-scripts.com",
              "media-src 'self' https://firebasestorage.googleapis.com",
              "object-src 'none'",
              "base-uri 'self'",
              "script-src 'self' 'unsafe-inline' https://*.googletagmanager.com https://*.google-analytics.com https://va.vercel-scripts.com",
              "script-src-elem 'self' 'unsafe-inline' https://*.googletagmanager.com https://*.google-analytics.com https://va.vercel-scripts.com",
              "style-src 'self' 'unsafe-inline'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
        ],
      },
      // Long-lived caching for static versioned media assets.
      {
        source: "/videos/:path*",
        headers: longCacheHeaders,
      },
      {
        source: "/fonts/:path*",
        headers: longCacheHeaders,
      },
      {
        source: "/photos/herograin.jpg",
        headers: longCacheHeaders,
      },
      {
        source: "/photos/og-default.jpg",
        headers: longCacheHeaders,
      },
    ];
  },
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
