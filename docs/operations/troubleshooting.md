# Troubleshooting Guide

Use this guide to diagnose and fix common problems with the Deep Dive Brewing Co website. If a step is marked with a cost or data risk, proceed carefully.

---

## Beer photos not loading

**Visible symptom:** A beer detail page or the `/beers` grid shows a broken image icon or blank space where a beer image should be.

**Likely causes:**

- The image file is missing from Firebase Storage.
- The image path in the beer record is wrong.
- Firebase Storage is returning an error because of billing or permissions.
- Next.js Image Optimization cannot fetch or process the image.
- The browser is showing a stale cached image.

**Safe diagnostic checks:**

1. Open the beer detail page in a browser.
2. Right-click the broken image and open the image URL in a new tab.
3. Check the browser console for `img-src` CSP errors.
4. In the admin dashboard, open the beer record and confirm the **Card Image Path** and **Hero Image Path** values.
5. Check the Vercel build logs for image-optimization errors.

**Recommended fix:**

- Re-upload the image in the admin dashboard and save the beer record.
- If the direct Firebase Storage URL returns a billing error, see [Firebase 402/403 errors](#firebase-402403-errors) below.
- If the direct URL works but the optimized URL fails, see [Next.js image optimizer 502 errors](#nextjs-image-optimizer-502-errors) below.
- Clear the browser cache or hard-refresh the page.

**When to escalate:** If the problem affects many images at once or re-uploading does not help, contact a developer with the failing URL and the browser console output.

---

## Google admin login failing

**Visible symptom:** You click **Sign in with Google** on `/admin` but nothing happens, the popup closes, or you see an error message.

**Likely causes:**

- Popups are blocked.
- The browser is in a strict privacy mode or container.
- The current domain is not authorized in Firebase Authentication.
- The Firebase Auth helper iframe is blocked by CSP.
- You are signing in with a Google account that does not have valid admin custom claims.
- Your ID token has not been refreshed after a role change or invitation acceptance.
- Third-party cookies are blocked.

**Safe diagnostic checks:**

1. Open the browser console and look for CSP errors, `auth/` errors, or 403/429 errors.
2. Try an incognito/private window with extensions disabled.
3. Confirm the domain in the address bar is in Firebase Authentication authorized domains.
4. Ask a superadmin to check the **Access** tab and confirm your account is active.

**Recommended fix:**

- Allow popups and third-party cookies for `deepdivebrewing.com`.
- Add the preview or production domain to Firebase Authentication authorized domains.
- Confirm `frame-src` in `next.config.ts` includes the Firebase Auth helper origin derived from `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`.
- Sign out and sign back in to refresh your Firebase ID token.
- If you were just invited, make sure you accepted the invitation and then signed out and back in.

For detailed steps, see [Login and access troubleshooting](../admin/login-and-access.md).

**When to escalate:** If you see a specific Firebase error code that you cannot resolve, share the exact code and browser console output with a developer.

---

## Contact map blank

**Visible symptom:** The `/contact` page shows an empty box where the Google Maps embed should be.

**Likely causes:**

- The map iframe is blocked by `frame-src` CSP.
- The Google Maps embed URL is malformed.
- Network requests to Google Maps are blocked by a privacy extension.

**Safe diagnostic checks:**

1. Open the browser console and look for CSP violations mentioning `maps.google.com` or `www.google.com`.
2. Inspect the iframe element and confirm the `src` URL is `https://www.google.com/maps?q=66+Fort+Bay+Road,+The+Bottom,+Saba&output=embed`.
3. Try loading the embed URL directly in a browser tab.

**Recommended fix:**

- Confirm `frame-src` in `next.config.ts` includes `https://www.google.com` and `https://maps.google.com`.
- If testing on a Vercel preview protected by SSO, the automated test may not reach the page; verify with a signed-in browser session.
- Disable privacy extensions temporarily for the site.

**When to escalate:** If the map works when loaded directly but not on the site, contact a developer to review the CSP and iframe URL.

---

## Public content missing

**Visible symptom:** A beer, venue, or page section that should be live is not showing on the public site.

**Likely causes:**

- The record has **Public** unchecked in the admin dashboard.
- The page is static and has not been rebuilt since the change.
- Firestore has no matching public record.
- The page is cached by the browser or a CDN.

**Safe diagnostic checks:**

1. Open the admin dashboard and confirm the record has **Public** checked.
2. Visit the dynamic beer detail page (`/beers/<slug>`) directly; if it appears there but not on `/beers`, the listing page needs a rebuild.
3. Check the Vercel deployment status to confirm the latest build finished.
4. Hard-refresh the page.

**Recommended fix:**

- Check **Public** and save.
- Trigger a site rebuild from the admin dashboard.
- Clear browser cache and retry.

**When to escalate:** If the data exists in Firestore and a rebuild does not help, contact a developer to check the build logs and Firestore indexes.

---

## Admin edits not appearing

**Visible symptom:** You saved a change in the admin dashboard, but the public site still shows the old content.

**Likely causes:**

- The change was saved to Firestore but the static page has not been rebuilt.
- You changed the slug, which created a new record while the old record is still public.
- A cache is serving the old version.

**Safe diagnostic checks:**

1. Re-open the record in the admin dashboard to confirm the change was saved.
2. Check whether the affected page is static or dynamic:
   - Dynamic: `/beers/<slug>` updates on the next request.
   - Static: `/beers`, `/where-to-buy`, `/`, `/contact`, `/about`, `/trade`, and `sitemap.xml` need a rebuild.
3. Look for duplicate records if the slug was changed.

**Recommended fix:**

- Trigger a site rebuild from the admin dashboard.
- If the slug was changed, uncheck **Public** on the old record and save.
- Hard-refresh the public page.

**When to escalate:** If edits never persist or affect the wrong record, contact a developer to inspect Firestore directly.

---

## Firebase 402/403 errors

**Visible symptom:** Network requests to `firebasestorage.googleapis.com` or Firestore return `402 Payment Required` or `403 Forbidden`.

**Likely causes:**

- The Firebase project is on the Spark (free) plan, but Cloud Storage for Firebase requires the Blaze plan.
- Billing is disabled or a payment method has expired.
- Storage or Firestore security rules are too restrictive.

**Safe diagnostic checks:**

1. Open the Firebase console and check the billing status.
2. Confirm the project is on the Blaze plan.
3. Review the deployed `storage.rules` and `firestore.rules`.

**Recommended fix:**

- Re-enable billing or update the payment method in the Firebase console.
- Wait a few minutes for services to resume.
- If the error is a rule issue, redeploy the rules from the repository.

> **Data/billing warning:** Do not repeatedly upload or delete files while billing is disabled; charges may apply once billing resumes, and data may already exist. Verify billing status first.

**When to escalate:** If billing is active and 403 errors continue, contact a developer to review the security rules and IAM settings.

---

## Next.js image optimizer 502 errors

**Visible symptom:** The browser console shows `502 OPTIMIZED_EXTERNAL_IMAGE_REQUEST_INVALID` for an image URL.

**Likely causes:**

- The upstream Firebase Storage request failed (billing, permissions, missing file).
- The image URL points to a hostname not allowed in `images.remotePatterns`.
- The image file is corrupted or in an unsupported format.

**Safe diagnostic checks:**

1. Open the original Firebase Storage URL directly to see if it returns a valid image.
2. Check that the URL hostname is `firebasestorage.googleapis.com`.
3. Check `next.config.ts` to confirm the hostname is in `images.remotePatterns`.

**Recommended fix:**

- Fix the upstream Firebase Storage issue first (billing, permissions, or missing file).
- If the hostname is not allowed, add it to `images.remotePatterns` and redeploy.
- Re-upload a valid image if the file is corrupted.

**When to escalate:** If the direct Firebase Storage URL works but Next.js still returns 502, contact a developer with the failing optimized URL and the original URL.

---

## Firestore permission errors

**Visible symptom:** The admin dashboard shows "Firestore permission denied" when saving a beer or venue, or public pages show no data.

**Likely causes:**

- The signed-in user does not have an `admin: true` custom claim.
- The user's role is not authorized for the attempted action (for example, an admin trying to manage other admins).
- The security rules have not been deployed.
- The browser is using an expired or invalid Firebase Auth token.

**Safe diagnostic checks:**

1. Ask a superadmin to confirm your account is active in the **Access** tab.
2. Sign out and sign in again to refresh the token.
3. Check the Firebase console to confirm the rules are deployed.

**Recommended fix:**

- If access was recently changed, sign out and sign back in.
- If the account is disabled, a superadmin must reactivate it.
- Redeploy `firestore.rules` if they were recently changed.

**When to escalate:** If permissions fail for all admins, contact a developer immediately; the security rules may have been overwritten or misconfigured.

---

## CSP violations

**Visible symptom:** The browser console reports Content-Security-Policy violations for scripts, frames, images, or connections.

**Likely causes:**

- A new external service was added without updating the CSP.
- The Firebase Auth helper origin changed.
- Google Analytics, Maps, or YouTube origins are missing.

**Safe diagnostic checks:**

1. Read the exact violation message to identify the blocked origin and directive.
2. Compare the origin with the directives in `next.config.ts`.

**Recommended fix:**

- Add only the specific origin needed to the relevant directive.
- Do not use wildcards such as `https://*` or `'unsafe-eval'` unless absolutely necessary.
- Rebuild and redeploy after changing `next.config.ts`.

**When to escalate:** If the violation cannot be fixed without broadening the policy significantly, contact a developer to review the change.

---

## Vercel deployment failures

**Visible symptom:** A Git push or manual deploy fails in Vercel, or the preview URL returns an error.

**Likely causes:**

- A TypeScript error.
- An ESLint error.
- A missing environment variable required at build time.
- A Firebase request failed during static page generation.

**Safe diagnostic checks:**

1. Read the full Vercel build log.
2. Run the same commands locally:
   ```bash
   npm run lint
   npx tsc --noEmit
   npm run build
   ```
3. Check that all required environment variables are set in the Vercel dashboard.

**Recommended fix:**

- Fix lint or type errors before pushing.
- Add missing environment variables.
- If Firestore permission warnings appear with dummy config, confirm the preview/production environment has the real Firebase values.

**When to escalate:** If the build fails for a reason unrelated to code changes (for example, a Vercel platform error), contact Vercel support or a developer.

---

## Analytics scripts returning 404 locally

**Visible symptom:** Running `npm run start` locally shows 404 errors for `/_vercel/insights/script.js` or `/_vercel/speed-insights/script.js`.

**Likely cause:** Vercel Analytics and Speed Insights scripts are injected by the Vercel edge network. They are not served by the local Next.js server.

**Recommended fix:** This is expected during local development and can be ignored. Verify these scripts load on a deployed Vercel preview or production URL.

**When to escalate:** If the scripts also fail on a deployed Vercel URL, check that Analytics and Speed Insights are enabled in the Vercel project dashboard.

---

## Incorrect www or HTTP redirects

**Visible symptom:** Visiting `http://deepdivebrewing.com`, `http://www.deepdivebrewing.com`, or `https://www.deepdivebrewing.com` does not redirect to `https://deepdivebrewing.com`.

**Likely cause:** The redirect rules in `next.config.ts` are missing or misconfigured.

**Safe diagnostic checks:**

1. Test each URL variant with `curl -I` or a browser.
2. Inspect the response headers for `location` and status code.

**Recommended fix:**

- Confirm `next.config.ts` contains the HTTP-to-HTTPS and www-to-non-www 308 redirects.
- Redeploy the site after any change to `next.config.ts`.

**When to escalate:** If redirects are configured but not applied, contact a developer; the issue may be at the DNS or Vercel project-domain level.

---

## Admin access lockout

**Visible symptom:** No superadmin can sign in, so access cannot be managed through the website.

**Likely causes:**

- Custom claims were cleared or corrupted.
- The bootstrap superadmin account was accidentally disabled.
- The `SUPER_ADMIN_EMAIL` environment variable changed.

**Safe diagnostic checks:**

1. Verify that `SUPER_ADMIN_EMAIL` is set in Vercel.
2. Confirm the bootstrap account still exists in Firebase Authentication and is verified.
3. Check the `adminUsers` collection in Firestore for the bootstrap account's status.

**Recommended fix:**

1. A developer with Firebase Admin SDK credentials should run the bootstrap migration from a secure local environment:
   ```bash
   npm run bootstrap-superadmin
   ```
2. Ask the bootstrap superadmin to sign out and sign back in.
3. From the **Access** tab, restore any other administrators.

**When to escalate:** If the migration script fails or the Firebase project is inaccessible, contact a developer immediately.

---

## General escalation checklist

Before contacting a developer, gather:

- The exact URL where the problem happens.
- The browser and device (or if it is the Vercel build environment).
- The exact error message or console output.
- Steps you have already tried.
- Whether the issue affects production, a preview, or local development.
