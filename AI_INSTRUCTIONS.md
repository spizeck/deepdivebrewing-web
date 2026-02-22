# AI_INSTRUCTIONS.md

> Release baseline: **1.01** (`1.0.1`)
> Project state: **Shelved / maintenance mode**

## Project Overview

This repository is the marketing and trade website for **Deep Dive Brewing Co**.

**Primary goals:**
- Public-facing brewery website
- Beer catalog driven by Firestore
- Venue list (“Where to Buy”)
- Trade (B2B) information with future ordering support

This project is intentionally structured to scale into authenticated B2B ordering later without re-architecture.

---

## Tech Stack (Do Not Deviate)

- **Next.js** (App Router)
- **TypeScript**
- **Tailwind CSS**
- **shadcn/ui** for components
- **Firebase**
  - Firestore (structured data)
  - Firebase Storage (images)
- **MDX** for long-form content pages
- **Vercel** for deployment

Do **not** introduce:
- Redux, Zustand, or other global state unless explicitly requested
- Alternative UI libraries
- Backend servers outside Firebase
- Client-heavy data fetching patterns

Prefer **server components** and **static rendering** wherever possible.

---

## Routing & Page Structure

### Public Routes
- `/` — Home
- `/beers` — Beer catalog (Firestore)
- `/beers/[slug]` — Beer detail page (Firestore)
- `/where-to-buy` — Venue list (Firestore)
- `/about` — MDX
- `/contact` — MDX

### Admin Route
- `/admin` — Firebase-authenticated admin dashboard for beer/venue updates, image uploads, and rebuild trigger

### Trade (B2B)
- `/trade` — Wholesale info (MDX + form)
- `/trade/login` — reserved for future
- `/trade/order` — reserved for future
- `/trade/orders` — reserved for future

Do not implement auth or ordering unless explicitly requested.

---

## Data Sources

### Firestore Collections

#### beers
Each document represents a single beer.

Required fields:
- `name: string`
- `slug: string`
- `style: string`
- `abv: number`
- `ibu: number | null`
- `srm: number | null`
- `status: "core" | "seasonal" | "limited"`
- `descriptionShort: string`
- `tastingNotes: string[]`
- `images.hero: string`
- `images.label?: string`
- `isPublic: boolean`
- `sortOrder: number`

#### venues
Represents bars/restaurants or retailers.

Required fields:
- `name: string`
- `slug: string`
- `type: "bar_restaurant" | "retail"`
- `locationName: string`
- `carriesBeerSlugs: string[]`
- `tapBeerSlugs?: string[]`
- `canBeerSlugs?: string[]`
- `isPublic: boolean`
- `sortOrder: number`
- `links.website?: string`
- `links.maps?: string`
- `links.instagram?: string`
- `links.facebook?: string`
- `links.untappd?: string`
- `notesPublic?: string`

#### tradeLeads
Wholesale inquiry submissions.

Fields:
- `businessName`
- `contactName`
- `email`
- `phoneOrWhatsapp`
- `venueType`
- `message`
- `createdAt` (server timestamp)
- `status`

#### meta/siteRebuild
Admin-only rebuild and content-update metadata:
- `cooldownUntil`
- `lastTriggeredAt`
- `lastTriggeredBy`
- `contentUpdatedAt`
- `contentUpdatedBy`
- `lastContentUpdateType`

---

## Content Rules

### MDX
Use MDX for:
- About page
- Contact page
- Trade info page
- Policies and informational content

MDX files live in `/content`.

Do not embed business logic in MDX.

---

## UI & Design Guidelines

- Use **shadcn/ui** components whenever possible
- Keep UI clean, minimal, and brewery-appropriate
- Prefer:
  - Card
  - Badge
  - Button
  - Tabs
  - Select
- Avoid heavy animations
- Mobile-first layout
- Max content width ~1200px

---

## Components & Structure

Preferred folders:
- `/app` — routes
- `/components` — reusable UI components
- `/components/ui` — shadcn components
- `/lib` — Firebase, data fetching, utilities
- `/content` — MDX files
- `/public` — static assets only

Do not put Firestore logic inside UI components.  
Data access belongs in `/lib`.

---

## Firebase Usage Rules

- Firestore reads should be server-side whenever possible
- Client-side writes are allowed **only** for:
  - Trade lead form
- Images are stored in Firebase Storage
- Image URLs are stored in Firestore
- Always use Next.js `<Image />`

---

## Coding Standards

- Type everything
- Use explicit interfaces for Firestore documents
- Avoid `any`
- Keep components small and composable
- Prefer named exports
- No dead code or commented-out experiments

---

## SEO & Metadata

- Each beer page should set metadata:
  - Title: `{Beer Name} | Deep Dive Brewing Co`
  - Description from `descriptionShort`
- Use OpenGraph images where applicable
- Generate sitemap when appropriate

---

## Development Philosophy

- Build incrementally
- Do not over-engineer
- Future-proof structure, not features
- One responsibility per component
- Leave TODO comments for future B2B features instead of implementing placeholders

---

## Important Constraints

- Do not change architectural decisions unless explicitly asked
- Do not refactor unrelated code
- Do not introduce auth, payments, or inventory logic unless requested
- Do not guess business rules — ask or leave TODOs

---

## Success Criteria

This project is successful when:
- Beers are easy to browse and understand
- Visitors can quickly see where to buy
- Trade customers know how to contact us
- The codebase is calm, readable, and extensible
