# Deep Dive Brewing Co — Website

> Release: **1.0.2** (package version `1.0.2`)
> Status: **Active**

Public-facing marketing and trade website for **Deep Dive Brewing Co**, a craft brewery on Saba.

## Tech Stack

- **Next.js 16** (App Router, server components)
- **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui**
- **Firebase** (Firestore, Storage)
- **MDX** for long-form content
- **Vercel** for deployment

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- A Firebase project with Firestore and Storage enabled

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment template and fill in your Firebase credentials:
   ```bash
   cp .env.local.example .env.local
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
app/              → Routes (App Router)
components/ui/    → shadcn/ui components
lib/              → Firebase client, data fetching, types, utilities
content/          → MDX content files
public/           → Static assets, favicons, manifest
```

## Routes

| Path | Description |
|---|---|
| `/` | Home |
| `/beers` | Beer catalog (Firestore) |
| `/beers/[slug]` | Beer detail page (Firestore) |
| `/where-to-buy` | Venue list (Firestore) |
| `/about` | About page (MDX) |
| `/contact` | Contact page (MDX) |
| `/trade` | Wholesale info (MDX) |
| `/admin` | Admin dashboard (Firebase Auth gated) |

## Firestore Collections

- **beers** — Beer catalog entries
- **venues** — Bars, restaurants, retailers
- **tradeLeads** — Wholesale inquiry submissions
- **meta/siteRebuild** — Rebuild cooldown + audit metadata

## Design System

See [THEME_AND_BRANDING.md](./THEME_AND_BRANDING.md) for the complete visual design system including colors, typography, spacing, and animation guidelines.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run optimize-assets` | Recompress hero image and generate OG image |

## Deployment

Deployed to [Vercel](https://vercel.com). Push to `main` to trigger a production deploy.

### Admin Rebuild Flow

The admin dashboard includes a **Rebuild Site** button that:

1. Verifies admin identity with Firebase ID token
2. Calls the server route `POST /api/admin/rebuild`
3. Triggers a Vercel Deploy Hook
4. Enforces cooldown to prevent repeated rebuilds

The dashboard also shows:

- Last rebuild triggered by / at
- Warning when content has changed since the last rebuild

## Public Repository Notice

This repository is public for transparency and reference. No secrets, API keys, or private keys are stored in source control. All sensitive configuration is injected via environment variables (see `.env.local.example`).

The public Firebase configuration values are safe to expose; access to Firebase services is controlled by Firebase Security Rules and App Check.

## Environment Variables

See `.env.local.example` for all required keys.

### Core App

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_GA_ID`
- `RESEND_API_KEY`
- `TRADE_INQUIRY_TO_EMAIL`

### Admin Rebuild Endpoint

- `VERCEL_DEPLOY_HOOK_URL`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`
- `ADMIN_REBUILD_COOLDOWN_MS` (optional, default 600000)

## Shelving / Handoff Notes

When resuming work later:

1. Confirm Vercel env vars are still set (especially admin + deploy hook values).
2. Verify Firebase Auth Google provider is enabled for admin emails.
3. Re-deploy Firebase rules (`firestore.rules`, `storage.rules`) if needed.
4. Test `/admin` login, save a record, and run one rebuild.

## Legal & Licensing

- **Copyright:** © 2024–2026 Deep Dive Brews, BV, trading as **Deep Dive Brewing Co**.
- **Code:** Released under the [MIT License](./LICENSE).
- **Brand & Content:** The Deep Dive Brewing Co name, logo, artwork, photography, and written content are the property of Deep Dive Brews, BV, and are not licensed for reuse, redistribution, or modification without explicit written permission.
- **Third-party assets:** Any third-party libraries remain under their respective licenses.

## Privacy & Data Handling

This site uses:

- **Google Analytics** for aggregated traffic measurement (via `NEXT_PUBLIC_GA_ID`).
- **Vercel Analytics** and **Vercel Speed Insights** for performance telemetry.
- **Firebase** for Firestore data and Storage assets.
- **Resend** for sending trade-inquiry emails.

No personal data is stored in this repository. Wholesale inquiry submissions are sent to the configured email address and may be stored in Firestore for follow-up.

## Security

If you discover a security vulnerability in this codebase or the live site, please email **info@deepdivebrewing.com** with details. Do not open a public issue for security-sensitive bugs.
