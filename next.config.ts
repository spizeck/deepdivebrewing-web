import type { NextConfig } from "next";
import createMDX from "@next/mdx";
import { withSentryConfig } from "@sentry/nextjs/config";
// tsconfig path aliases are not resolved inside next.config — keep this
// import relative.
import { siteUrl } from "./lib/site";

const firebaseAuthDomain =
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "deepdivebrewing-web.firebaseapp.com";
const firebaseAuthOrigin = firebaseAuthDomain.startsWith("http")
  ? firebaseAuthDomain
  : `https://${firebaseAuthDomain}`;

// The browser SDK sends events to the ingest origin embedded in the public
// DSN. Deriving the CSP entry from the configured DSN keeps connect-src to
// exactly one Sentry origin — and adds nothing when the DSN is unset
// (local dev, CI, previews).
const sentryIngestOrigin = (() => {
  try {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    return dsn ? new URL(dsn).origin : null;
  } catch {
    return null;
  }
})();

const versionedCacheHeaders = [
  {
    key: "Cache-Control",
    value: "public, max-age=31536000, immutable",
  },
];

const mediaCacheHeaders = [
  {
    key: "Cache-Control",
    value: "public, max-age=0, must-revalidate",
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
      // HTTP → HTTPS in one hop, permanent 308 (Vercel sets x-forwarded-proto).
      {
        source: "/:path*",
        has: [
          {
            type: "header",
            key: "x-forwarded-proto",
            value: "http",
          },
        ],
        destination: `${siteUrl}/:path*`,
        permanent: true,
      },
      // www → non-www in one hop, permanent 308.
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "www.deepdivebrewing.com",
          },
        ],
        destination: `${siteUrl}/:path*`,
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
              `connect-src 'self' ${siteUrl} https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://apis.google.com https://accounts.google.com https://firebasestorage.googleapis.com https://*.firebaseio.com https://*.googleapis.com https://vitals.vercel-insights.com https://va.vercel-scripts.com${sentryIngestOrigin ? ` ${sentryIngestOrigin}` : ""}`,
              "font-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
              // Google Maps only ever frames www.google.com — nothing frames
              // maps.google.com (external Maps links are plain navigations).
              `frame-src 'self' https://www.google.com https://accounts.google.com ${firebaseAuthOrigin} https://www.youtube.com https://www.youtube-nocookie.com`,
              "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://*.googleusercontent.com https://*.google-analytics.com https://*.googletagmanager.com https://*.gstatic.com https://va.vercel-scripts.com",
              "media-src 'self' https://firebasestorage.googleapis.com",
              "object-src 'none'",
              "base-uri 'self'",
              "script-src 'self' 'unsafe-inline' https://*.googletagmanager.com https://*.google-analytics.com https://apis.google.com https://accounts.google.com https://va.vercel-scripts.com",
              "script-src-elem 'self' 'unsafe-inline' https://*.googletagmanager.com https://*.google-analytics.com https://apis.google.com https://accounts.google.com https://va.vercel-scripts.com",
              "style-src 'self' 'unsafe-inline'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
        ],
      },
      // Fonts served by Next.js use content-hashed filenames, so immutable is safe.
      {
        source: "/fonts/:path*",
        headers: versionedCacheHeaders,
      },
      // Fixed public media URLs are not content-hashed; use revalidation so updates show immediately.
      {
        source: "/videos/:path*",
        headers: mediaCacheHeaders,
      },
      {
        source: "/photos/herograin.jpg",
        headers: mediaCacheHeaders,
      },
      {
        source: "/photos/og-default.jpg",
        headers: mediaCacheHeaders,
      },
    ];
  },
};

const withMDX = createMDX({});

// Sentry build integration (Issue #92): uploads production source maps so
// minified stack traces symbolicate, and stamps the release. Credentials
// come from the environment — SENTRY_ORG/SENTRY_PROJECT/SENTRY_AUTH_TOKEN
// (Vercel Production scope). Without an auth token the upload is disabled
// entirely, keeping credential-free local/CI/preview builds inert; the
// auth token is build-time only and never enters the client bundle.
// deleteSourcemapsAfterUpload keeps the maps out of the publicly served
// assets after upload.
export default withSentryConfig(withMDX(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Release matches the runtime release (VERCEL_GIT_COMMIT_SHA /
  // NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA) so events and maps line up.
  release: process.env.VERCEL_GIT_COMMIT_SHA
    ? { name: process.env.VERCEL_GIT_COMMIT_SHA }
    : undefined,
  telemetry: false,
  silent: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
  widenClientFileUpload: true,
});
