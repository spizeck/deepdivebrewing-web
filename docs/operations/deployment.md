# Deployment Guide

This guide describes how the Deep Dive Brewing Co website is built, previewed, and deployed.

## Branch and pull-request workflow

The repository uses Git with Vercel Git integration.

1. Create a feature or fix branch from the main development branch.
2. Make your changes.
3. Push the branch to GitHub.
4. Open a pull request.
5. Vercel automatically builds a preview deployment for the pull request.
6. Review the preview, run checks, and merge when ready.

> **Note:** The production branch name is configured in Vercel. Typically it is `main`, but confirm in the Vercel project settings if you are unsure.

## Vercel preview deployments

Every push to a branch and every pull request creates a preview URL. You can use this URL to verify changes with real Firebase data before merging.

Preview URLs look like:

```
https://deepdivebrewing-<random>-<team>.vercel.app
```

### Important notes about previews

- Preview deployments use the same Firebase project as production if the environment variables point to it.
- Preview domains must be added to **Firebase Authentication > Settings > Authorized domains** if you need to test Google sign-in on a preview URL.
- The `frame-src` Content-Security-Policy is built at deploy time using the value of `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`. If that environment variable is not set for the preview, the fallback domain is used.

## Production deployment

Merging an approved pull request into the production branch triggers a production deploy on Vercel.

You can also deploy manually from the Vercel dashboard or CLI, but this guide assumes Git-based deployment.

## Environment-variable scopes

Environment variables are managed in the Vercel dashboard.

### Public variables (available in the browser)

These variables are prefixed with `NEXT_PUBLIC_` and are embedded in the client bundle. They are safe to expose because they configure Firebase client access only. Actual data access is controlled by Firebase Security Rules.

Examples:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_GA_ID`

### Server-only variables

These variables are used only by API routes or build-time scripts and must not be exposed to the browser.

Examples:

- `RESEND_API_KEY`
- `TRADE_INQUIRY_TO_EMAIL`
- `VERCEL_DEPLOY_HOOK_URL`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`
- `ADMIN_REBUILD_COOLDOWN_MS`

## How to verify a preview with populated Firebase data

Local development can run with sample or empty data. To verify a preview with real data:

1. Open the Vercel preview URL.
2. Navigate to `/beers` and confirm the current beer list loads.
3. Visit `/where-to-buy` and confirm partner venues appear.
4. Visit a beer detail page (`/beers/<slug>`) and confirm images load.
5. Visit `/contact` and confirm the map renders.
6. Visit `/admin` and confirm the sign-in button loads (complete sign-in only on an authorized domain).

If data is missing, check that the preview environment variables match the production Firebase project.

## Domain and redirect behavior

The site is configured to redirect:

- HTTP to HTTPS with a permanent 308 redirect.
- `www.deepdivebrewing.com` to `deepdivebrewing.com` with a permanent 308 redirect.

These redirects are defined in `next.config.ts`.

## Admin-triggered rebuilds

The admin dashboard has a **Rebuild Site** button. When clicked:

1. The dashboard sends a Firebase ID token to `POST /api/admin/rebuild`.
2. The server verifies the user is in the admin allow-list.
3. The server calls the Vercel Deploy Hook configured in `VERCEL_DEPLOY_HOOK_URL`.
4. Vercel starts a new production build.
5. A cooldown prevents repeated rebuilds. The default cooldown is 10 minutes (`ADMIN_REBUILD_COOLDOWN_MS=600000`).

The rebuild is needed because the following pages are static and only update at build time:

- `/` (homepage)
- `/beers`
- `/where-to-buy`
- `/about`
- `/contact`
- `/trade`
- `sitemap.xml`

Beer detail pages (`/beers/<slug>`) are rendered on demand, so they reflect Firestore changes without a rebuild.

## Rollback procedure

If a production deploy causes problems:

1. Identify the last known good commit from the Git history or Vercel deployment list.
2. In the Vercel dashboard, find the previous production deployment and click **Promote to Production**.
   - This is usually the fastest rollback.
3. Alternatively, revert the problematic commit in Git and merge the revert to the production branch.
4. After rollback, verify the live site.

> **Warning:** Promoting a previous deployment is faster than reverting and redeploying, but make sure the previous deployment is actually working before promoting it.

## Post-deployment smoke tests

After any production deployment, run through these checks:

1. Load https://deepdivebrewing.com and confirm the homepage renders.
2. Load `/beers` and confirm the beer grid appears.
3. Click into a beer detail page and confirm the image and metadata load.
4. Load `/where-to-buy` and confirm venue groups appear.
5. Load `/contact` and confirm the map loads.
6. Load `/trade` and confirm the inquiry form renders.
7. Open the browser console and confirm there are no CSP violations or 404 errors.
8. Test a Google sign-in attempt on `/admin` (complete login only if you are authorized).

For a full checklist, see [Post-deployment checklist](./post-deployment-checklist.md).

## How to confirm which commit is in production

1. Open the Vercel dashboard for the project.
2. Go to the production deployment.
3. The deployment details show the Git commit SHA and message.
4. Compare that commit with the latest commit in the repository's production branch.

You can also check the response headers of the live site for build information, but the Vercel dashboard is the most reliable source.

## Related guides

- [Post-deployment checklist](./post-deployment-checklist.md)
- [Troubleshooting](./troubleshooting.md)
- [Admin handbook](../admin/README.md)
