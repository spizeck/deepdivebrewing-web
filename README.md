# Deep Dive Brewing Co — Website

> Release: **1.0.2** (package version `1.0.2`)  
> Status: **Active**

Public-facing marketing and trade website for **Deep Dive Brewing Co**, a craft brewery on Saba.

## Live URLs

- **Production site:** https://deepdivebrewing.com
- **Admin dashboard:** https://deepdivebrewing.com/admin

## What this project does

The site markets Deep Dive Brewing Co beers, tells the brewery story, lists partner venues, and collects wholesale/trade inquiries. A small admin dashboard lets authorized staff manage the beer catalog, venue list, and trigger site rebuilds after content changes.

## Technology overview

- **Next.js 16** with App Router and React Server Components
- **TypeScript**
- **Tailwind CSS v4** and **shadcn/ui**
- **Firebase** — Firestore, Storage, and Authentication (Google sign-in)
- **MDX** for long-form content
- **Vercel** hosting, preview deployments, and Analytics/Speed Insights
- **Google Analytics 4** via GTM/gtag
- **Resend** for trade-inquiry email delivery

## Repository structure

```
app/                 → Next.js App Router routes
components/          → React components, including admin UI
components/ui/       → shadcn/ui building blocks
lib/                 → Firebase clients, data helpers, types, utilities
content/             → MDX content files
public/              → Static assets, favicons, manifest, videos, photos
docs/                → Administrator and operations guides
scripts/             → Utility and verification scripts
firestore.rules      → Firestore security rules
storage.rules        → Firebase Storage security rules
```

See the [docs/](./docs/) directory for detailed guides.

## Prerequisites

- Node.js 20+
- npm
- A Firebase project with Firestore and Storage enabled
- Vercel project (for deployment)

## Local setup

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment template and fill in your values:
   ```bash
   cp .env.local.example .env.local
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000).

> Local development can use dummy Firebase values, but populated beer/venue data and image uploads require real Firebase credentials.

## Required environment variables

See `.env.local.example` for the complete list. Key variables include:

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
- `VERCEL_DEPLOY_HOOK_URL`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`
- `ADMIN_REBUILD_COOLDOWN_MS` (optional, default `600000`)
- `SUPER_ADMIN_EMAIL` (server-only; the verified Google account that receives the bootstrap superadmin role)

Never commit real values to source control. `.env.local` is already ignored by Git.

## Firebase services used

- **Firestore** — beer records, venue records, trade leads metadata, and rebuild audit metadata.
- **Firebase Storage** — beer card and hero images.
- **Firebase Authentication** — Google sign-in with role-based admin access controlled by Firebase custom claims.

## Development commands

| Command | Description |
|---|---|
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build for production |
| `npm run start` | Start the production server locally |
| `npm run lint` | Run ESLint |
| `npx tsc --noEmit` | Run TypeScript type-checking |
| `npm test` | Run the Node.js test suite |
| `npm run optimize-assets` | Recompress hero image and generate OG image |
| `npm run seed:beers` | Seed sample beer data (developer script) |
| `npm run seed:venues` | Seed sample venue data (developer script) |
| `npm run bootstrap-superadmin` | Grant the initial superadmin role to `SUPER_ADMIN_EMAIL` (see docs first)

## Deployment overview

The site deploys on Vercel.

- Pushes and pull requests automatically create preview deployments.
- Merging into the production branch triggers a production deploy.
- The admin dashboard can trigger an on-demand rebuild by calling a Vercel Deploy Hook (`POST /api/admin/rebuild`).

See [docs/operations/deployment.md](./docs/operations/deployment.md) for branch workflow, rollback, and smoke-test steps.

## Documentation

### For administrators

- [Admin handbook](./docs/admin/README.md)
- [Login and access](./docs/admin/login-and-access.md)
- [Managing access](./docs/admin/managing-access.md)
- [Managing beers](./docs/admin/managing-beers.md)
- [Managing locations](./docs/admin/managing-locations.md)
- [Images and storage](./docs/admin/images-and-storage.md)
- [Trade inquiries](./docs/admin/trade-inquiries.md)

### For developers and operators

- [Deployment guide](./docs/operations/deployment.md)
- [Troubleshooting guide](./docs/operations/troubleshooting.md)
- [Post-deployment checklist](./docs/operations/post-deployment-checklist.md)

## Security and secret management

- No secrets, API keys, or private keys are stored in source control.
- All sensitive configuration is injected via environment variables.
- Firebase client configuration values prefixed with `NEXT_PUBLIC_` are safe to expose in the browser; access is controlled by Firebase Security Rules and Firebase custom claims.
- The bootstrap superadmin email (`SUPER_ADMIN_EMAIL`) is a server-only environment variable and must never be exposed to the browser.
- The Firebase service-account key (`FIREBASE_ADMIN_PRIVATE_KEY`) must stay in Vercel environment variables and local `.env.local` only.

If you discover a security vulnerability, email **info@deepdivebrewing.com** instead of opening a public issue.

## Public repository notice

This repository is public for transparency and reference. The Deep Dive Brewing Co name, logo, artwork, photography, and written content are the property of Deep Dive Brews, BV, and are not licensed for reuse without explicit written permission. Third-party libraries remain under their respective licenses.
