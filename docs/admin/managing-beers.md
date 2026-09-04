# Managing Beers

This guide explains how to update the beer catalog on the Deep Dive Brewing Co website.

> **Warning:** Saving changes writes to the live production database immediately. Always review your work before clicking **Save Beer**.

## Viewing the beer list

1. Sign in to the admin dashboard at https://deepdivebrewing.com/admin.
2. Make sure the **Beers** tab is selected.
3. The left panel shows all beer records sorted by the **Sort Order** value.
4. Click a beer name to load it into the form on the right.

## Creating a new beer

1. In the **Beers** tab, click the **New** button above the beer list.
2. The form on the right clears and shows empty default values.
3. Fill in the required fields.
4. Click **Save Beer**.

## Editing an existing beer

1. Click the beer name in the left panel.
2. Update the fields you want to change.
3. Click **Save Beer**.

## Available fields

| Field | Required | What it does |
|---|---|---|
| **Name** | Yes | The beer's display name on cards, detail pages, and metadata. |
| **Slug** | Yes | The URL-friendly identifier. Used as the Firestore document ID and in URLs such as `/beers/<slug>`. |
| **Style** | Yes | The beer style shown under the name, for example "NEIPA" or "Pale Lager". |
| **Status** | Yes | Choose **Core**, **Seasonal**, or **Limited**. Filters the public beer listing. |
| **ABV** | Yes | Alcohol by volume as a number, for example `6.5`. |
| **Sort Order** | Yes | Controls the order beers appear in lists. Lower numbers appear first. |
| **Short Description** | Recommended | A short paragraph shown on the beer detail page. |
| **Tasting Notes** | Optional | Comma-separated descriptive words or phrases, for example `citrus, tropical, hazy`. These appear as badges. |
| **Card Image Path** | Optional | The Firebase Storage path for the thumbnail/card image. Usually filled automatically when you upload an image. |
| **Hero Image Path** | Optional | The Firebase Storage path for the large detail-page image. Usually filled automatically when you upload an image. |
| **Public** | Yes | If checked, the beer is visible on the public site. Uncheck to hide it without deleting the record. |

> **Note:** The `Beer` data type also supports `IBU` and `SRM` values, but these are not editable in the current admin form. If those values are set in Firestore directly, they display on the public detail page. The admin UI cannot add or change them.

## Slug rules

- The slug is used as the Firestore document ID.
- The form automatically converts the slug to lowercase and trims spaces.
- A good slug is short, descriptive, and URL-safe, for example `island-neipa` or `saba-session-lager`.

> **Important:** If you change the slug of an existing beer, the dashboard saves a **new** Firestore document with the new slug. The old document is not automatically deleted. To avoid duplicate records, create a new beer with the new slug and then edit the old record to uncheck **Public**, or ask a developer to remove the old document from Firestore.

## Beer status

- **Core** — Always available, year-round beers.
- **Seasonal** — Available during a specific season or period.
- **Limited** — Small-batch or one-off releases.

The public `/beers` page lets visitors filter by these statuses.

## Uploading images

You can upload images in two ways:

1. **Upload Card Image** — click the file input under **Upload Card Image** and choose an image.
2. **Upload Hero Image** — click the file input under **Upload Hero Image** and choose an image.

After the upload finishes, the corresponding path field is updated automatically. You must still click **Save Beer** to store the new path in the beer record.

> **Recommendation:** Upload images **after** setting the final slug. If you change the slug after uploading, the image path still refers to the old slug folder and may be confusing to manage.

### Supported formats and recommended dimensions

- **Formats:** JPEG, PNG, WebP, AVIF.
- **Card image:** portrait orientation. Recommended ratio 4:5, for example 800 × 1000 pixels.
- **Hero image:** landscape orientation. Recommended ratio 16:9, for example 1200 × 675 pixels.
- Keep file sizes reasonable (under 500 KB each) so the site loads quickly.
- Use descriptive filenames before upload; the system renames files automatically.

For more details about storage, caching, and troubleshooting image problems, see [Images and storage](./images-and-storage.md).

## Saving and confirming a change

1. Click **Save Beer**.
2. A status message appears below the form when the save is complete.
3. If saving succeeds, the beer list refreshes and the updated beer stays selected.

## How changes appear on the public site

- **Beer detail pages** (`/beers/<slug>`) are rendered on demand, so edits appear on the next visit.
- **Beer listing page** (`/beers`), **homepage carousel**, and **sitemap** are generated at build time, so they only show new or changed beers after a site rebuild.
- If you make a change that should appear on a listing page, click **Rebuild Site** in the admin header and wait for the deployment to finish.

## SEO and structured data

Each public beer page automatically generates:

- A page title, meta description, Open Graph tags, and Twitter card.
- `Product` structured data (JSON-LD) with name, description, image, ABV, IBU (if present), and SRM (if present).
- Breadcrumb navigation back to `/beers`.

The meta description uses the beer name, style, ABV, and first tasting note. Writing a clear **Short Description** and **Style** improves search-engine snippets.

## Removing or hiding a beer

The admin form does **not** have a delete button. To remove a beer from public view:

1. Open the beer record.
2. Uncheck **Public**.
3. Click **Save Beer**.

The beer record remains in Firestore but no longer appears on public pages. Only a developer can permanently delete the document from Firestore.

## Recovery options if content is changed incorrectly

- **Wrong text but correct slug:** Edit the beer again and save the corrected values.
- **Wrong slug created a duplicate:** Edit the old record to uncheck **Public**, then update the new record as needed. Ask a developer to delete the duplicate document if necessary.
- **Wrong image uploaded:** Upload a replacement image and save the beer. The old image file remains in Storage; ask a developer to clean it up if needed.
- **Accidentally saved while incomplete:** Re-open the record, complete the fields, and save again.

## Pre-publish checklist

Before saving a new or updated beer, confirm:

- [ ] Name and slug are correct.
- [ ] Slug is URL-friendly and lowercase.
- [ ] Style is filled in.
- [ ] ABV is a number, for example `5.2`.
- [ ] Status matches the release plan (Core, Seasonal, or Limited).
- [ ] Sort order is set so the beer appears in the right place.
- [ ] Short description reads well for visitors and search engines.
- [ ] Tasting notes are spelled correctly and comma-separated.
- [ ] Card and hero images are uploaded and look right on the public site.
- [ ] **Public** is checked if the beer should be live.
- [ ] If the change affects listing pages, a rebuild is triggered afterward.
