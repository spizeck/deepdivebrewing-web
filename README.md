# Deep Dive Brewing Co — Website

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

- Node.js 18+
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

## Firestore Collections

- **beers** — Beer catalog entries
- **venues** — Bars, restaurants, retailers
- **tradeLeads** — Wholesale inquiry submissions

## Design System

See [THEME_AND_BRANDING.md](./THEME_AND_BRANDING.md) for the complete visual design system including colors, typography, spacing, and animation guidelines.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |

## Deployment

Deployed to [Vercel](https://vercel.com). Push to `main` to trigger a production deploy.

## Environment Variables

All Firebase configuration is loaded from environment variables. See `.env.local.example` for the required keys.

## License

Private — all rights reserved.
