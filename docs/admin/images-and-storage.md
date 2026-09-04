# Images and Storage

This guide explains how beer images are stored, how they appear on the public site, and how to fix common image problems.

## Where beer images are stored

Beer card and hero images are stored in **Firebase Cloud Storage** in the project's configured bucket. The bucket name comes from the `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` environment variable.

When you upload an image from the admin dashboard, the file is placed in a path like:

```
beers/<beer-slug>/<slug>_<kind>_<timestamp>.<extension>
```

For example:

```
beers/island-neipa/island-neipa_hero_1699123456789.jpg
```

Only the **object path** is saved in the beer record. The public site converts the path into a full download URL when the page loads.

## How Firebase Storage URLs are generated

The path stored in Firestore is turned into a URL using the project's bucket:

```
https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded-path>?alt=media
```

This URL is then passed through Next.js Image Optimization, which rewrites it to an optimized, resized image URL such as `/_next/image?url=...`.

## Expected bucket name

The bucket name is the value of `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`. It usually looks like `<project-id>.appspot.com` or a custom bucket name. The application reads it from the environment at build or runtime; do not change it in the code.

## How Next.js Image Optimization handles Firebase images

Next.js is configured to optimize external images from `firebasestorage.googleapis.com`. The configuration lives in `next.config.ts` under `images.remotePatterns`.

When a page loads a beer image:

1. Next.js receives the Firebase Storage URL.
2. It checks that the hostname is allowed.
3. It fetches the image from Firebase Storage.
4. It serves an optimized WebP/AVIF copy sized for the visitor's device.

This means the first request after an upload may take slightly longer while Next.js caches the optimized version.

## Permitted remote-image host

Only `firebasestorage.googleapis.com` is permitted by the Next.js image configuration. If an image URL points anywhere else, Next.js will refuse to optimize it and the image will not load.

## Recommended image specifications

### File types

Use one of these formats:

- **WebP** — best balance of quality and file size (preferred).
- **AVIF** — even smaller, but older browsers may not support it.
- **JPEG** — widely compatible; use when WebP/AVIF is unavailable.
- **PNG** — only when transparency is required.

### Dimensions and aspect ratios

- **Card image:** portrait, approximately 4:5 ratio. Recommended size 800 × 1000 pixels.
- **Hero image:** landscape, approximately 16:9 ratio. Recommended size 1200 × 675 pixels.
- **Open Graph / social share image:** 1200 × 630 pixels (this is the default `og-default.jpg` in `public/photos/`).

### Compression

- Keep each image under 500 KB when possible.
- Use quality 80–85 for photographs.
- Avoid uploading extremely large originals; Next.js resizes them, but smaller sources load faster.

### File-naming conventions

The admin dashboard renames uploaded files automatically, but it helps to start with a clean filename:

- Use lowercase letters, numbers, and hyphens only.
- Avoid spaces and special characters.
- Example: `island-neipa-hero.jpg`.

## Accessibility

Beer images must have useful alternative text. The public site uses the beer name as the image `alt` attribute. Make sure the **Name** field is descriptive, for example "Island NEIPA" rather than generic text.

## Replacing images safely

> **Warning:** The admin dashboard does not delete old files from Firebase Storage. Uploading a replacement creates a new file, and the beer record now points to the new file. The old file remains in the bucket until a developer removes it.

To replace an image:

1. Open the beer record.
2. Under **Upload Card Image** or **Upload Hero Image**, choose the new file.
3. Wait for the upload to finish. The path field updates automatically.
4. Click **Save Beer**.
5. Visit the public beer page to confirm the new image appears.

## Caching considerations

- Firebase Storage URLs are public and cacheable.
- Next.js Image Optimization caches the optimized versions. The cache time-to-live is set to one year (`minimumCacheTTL: 31536000`).
- Because the filename includes a timestamp, replacing an image produces a fresh URL, so visitors see the update quickly.
- If you change an image but keep the same filename and URL, visitors may see the cached version until the cache expires.

## Verifying an uploaded image on the public site

1. Save the beer record after uploading.
2. Open the beer detail page at `https://deepdivebrewing.com/beers/<slug>`.
3. Check that the hero image loads.
4. Visit `/beers` and confirm the card image loads. Remember that listing pages may need a site rebuild to show a brand-new beer.

## Diagnosing image problems

### Missing or deleted file

**Symptom:** The image URL returns a 404 from Firebase Storage.

**Checks:**

- Open the image URL directly in a browser.
- Look in the Firebase Storage console under the `beers/<slug>/` folder.

**Fix:** Re-upload the image in the admin dashboard and save the beer record.

### Firebase billing problem

**Symptom:** Image URLs return `402 Payment Required` or `403 Forbidden` from `firebasestorage.googleapis.com`. Next.js may show `502 OPTIMIZED_EXTERNAL_IMAGE_REQUEST_INVALID`.

**Cause:** Cloud Storage for Firebase requires the **Blaze** (pay-as-you-go) plan. If billing is disabled or the project returns to the Spark plan, Storage requests can fail.

**Important lesson:** The files may still exist in the bucket even though they are temporarily inaccessible. Re-enabling billing usually restores access without needing to re-upload anything.

**Fix:**

1. Open the Firebase project billing section.
2. Confirm the Blaze plan is active and a valid payment method is attached.
3. Wait a few minutes for Firebase services to resume.
4. Re-check the image URLs.

> Do not re-upload all images until you have confirmed billing is active; repeated uploads may incur unnecessary charges.

### Storage permission problem

**Symptom:** Images return `403 Forbidden` even though billing is enabled.

**Checks:**

- Review `storage.rules`. Public read is allowed (`allow read: if true;`), so public pages should be able to load images.
- Confirm the rules have been deployed to Firebase.

**Fix:** Redeploy `storage.rules` from the project root:

```bash
firebase deploy --only storage
```

or ask a developer to deploy the rules.

### Invalid URL

**Symptom:** The browser tries to load a malformed image URL, or the URL does not point to an existing object.

**Checks:**

- Open the beer record and look at the **Card Image Path** or **Hero Image Path** field.
- The value should look like `beers/<slug>/<filename>.jpg`, not a full URL.

**Fix:** Re-upload the image, which resets the path, then save the beer.

### Next.js `remotePatterns` problem

**Symptom:** Next.js shows an error like `"hostname firebasestorage.googleapis.com is not configured"`.

**Cause:** The image hostname is not in `next.config.ts` `images.remotePatterns`.

**Fix:** This should already be configured. If it is missing, add `firebasestorage.googleapis.com` to `images.remotePatterns` in `next.config.ts`, then rebuild and redeploy. Do not add unrelated hostnames.

### CSP problem

**Symptom:** The browser console shows a `img-src` Content-Security-Policy violation.

**Checks:**

- Confirm `img-src` in `next.config.ts` includes `https://firebasestorage.googleapis.com`.

**Fix:** Add or confirm the Firebase Storage origin in `img-src`, then rebuild and redeploy.

### Stale browser or CDN cache

**Symptom:** You uploaded a new image, but you still see the old one.

**Checks:**

- Hard-refresh the page (`Ctrl+Shift+R` or `Cmd+Shift+R`).
- Open the image URL directly and compare it with the path in the beer record.
- Check whether the filename includes a new timestamp.

**Fix:** If the URL is the same, the cache is likely the cause. Wait a few minutes, or upload again with a different filename. In most cases, the timestamp in the filename avoids this problem.

## General safety tips

- Always upload images **after** the beer slug is finalized.
- Use the upload buttons rather than typing paths by hand.
- Keep image files reasonably small.
- Do not store personal information, credentials, or payment details in image filenames or metadata.
