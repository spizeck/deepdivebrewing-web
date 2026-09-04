# Managing Locations

This guide explains how to add, edit, and remove partner venues from the Deep Dive Brewing Co website.

> **Warning:** Saving changes writes to the live production database immediately. Double-check addresses, links, and beer availability before saving.

## Viewing partner venues

1. Sign in to the admin dashboard at https://deepdivebrewing.com/admin.
2. Select the **Venues** tab.
3. The left panel shows venue records sorted by **Sort Order**.
4. Click a venue name to load it into the form on the right.

## Creating a venue

1. In the **Venues** tab, click the **New** button above the venue list.
2. The form on the right clears and shows empty default values.
3. Fill in the required fields.
4. Select which beers the venue carries, has on tap, or has in can.
5. Click **Save Venue**.

## Editing an existing venue

1. Click the venue name in the left panel.
2. Update the fields you want to change.
3. Click **Save Venue**.

## Available fields

| Field | Required | What it does |
|---|---|---|
| **Name** | Yes | The venue's display name. |
| **Slug** | Yes | The URL-friendly identifier. Used as the Firestore document ID. Should be lowercase and hyphenated, for example `tropics-cafe`. |
| **Type** | Yes | Choose **Bar / Restaurant** or **Retail**. |
| **Location Name** | Recommended | The island or region. This controls how venues are grouped on `/where-to-buy`. See the region section below for exact values. |
| **Sort Order** | Yes | Controls the order venues appear within their group. Lower numbers appear first. |
| **Carries Beers** | Optional | Check every beer the venue currently carries in any format. |
| **On Tap** | Optional | Check beers the venue has on draft tap. |
| **In Can** | Optional | Check beers the venue sells in cans. |
| **Website** | Optional | The venue's website URL. Must include `https://`. |
| **Maps Link** | Optional | A link to Google Maps or another mapping service for directions. |
| **Instagram** | Optional | The venue's Instagram URL. |
| **Facebook** | Optional | The venue's Facebook URL. |
| **Public Notes** | Optional | Extra text shown on the public venue card, for example "Ask about the rotating tap." |
| **Public** | Yes | If checked, the venue is visible on `/where-to-buy`. Uncheck to hide it. |

## Region names and grouping logic

The `/where-to-buy` page groups venues by the **Location Name** field. The public page uses these rules to decide the heading for each group:

- If the location name contains `sxm`, `maarten`, or `martin`, the heading displays as **Sint Maarten / Saint Martin / SXM**.
- If the location name contains `statia` or `eustatius`, the heading displays as **Sint Eustatius / Statia**.
- Any other value has its first letter capitalized and is used as-is.

### Recommended exact values

Use simple, consistent values so grouping works predictably:

- `Saba`
- `SXM` (or `Sint Maarten`)
- `Statia` (or `Sint Eustatius`)

Examples:

- A venue on Saba should have **Location Name** set to `Saba`.
- A venue on Sint Maarten should use `SXM` or `Sint Maarten`.
- A venue on Saint Martin (French side) should use `Saint Martin` or `SXM`.

## How locations appear on `/where-to-buy`

- Only venues with **Public** checked are shown.
- Venues are grouped under headings based on **Location Name**.
- Inside each group, venues are sorted by **Sort Order**.
- Each venue card shows the name, type badge, public notes, and the beers listed under **On Tap** and **In Can**.
- Links for Website, Directions, Instagram, and Facebook appear when those fields are filled.

## Making Directions links work reliably

The **Maps Link** field should be a full URL. The public page opens it in a new tab.

Recommended format:

```
https://www.google.com/maps/dir/?api=1&destination=<latitude>,<longitude>
```

or

```
https://www.google.com/maps/search/?api=1&query=<venue+name+location>
```

For example:

```
https://www.google.com/maps/search/?api=1&query=Tropics+Cafe+Saba
```

Always test the link by opening it in a browser before saving.

## Removing or temporarily hiding a location

The admin form does **not** have a delete button. To remove a venue from public view:

1. Open the venue record.
2. Uncheck **Public**.
3. Click **Save Venue**.

The record stays in Firestore but is hidden from `/where-to-buy`. Only a developer can permanently delete the document.

## Avoiding duplicate venue records

To prevent duplicates:

- Search the venue list before creating a new record.
- Use a consistent slug format, for example `tropics-cafe-saba`.
- If you accidentally create a duplicate, edit the unwanted record to uncheck **Public** and ask a developer to delete it from Firestore.

> **Important:** Changing the slug of an existing venue saves a **new** Firestore document and leaves the old document in place. To avoid duplicates, only set the slug when creating the venue; do not rename it later unless you also hide or remove the old record.

## Pre-publish checklist

Before saving a new or updated venue, confirm:

- [ ] Name and slug are correct and unique.
- [ ] Slug is lowercase, hyphenated, and URL-safe.
- [ ] Type is correct (Bar / Restaurant or Retail).
- [ ] Location Name uses one of the recommended region values.
- [ ] Sort order is set.
- [ ] Website link is a full `https://` URL (if provided).
- [ ] Maps Link is a working URL that opens directions (if provided).
- [ ] Social links are full URLs (if provided).
- [ ] Beer selections (Carries, On Tap, In Can) are accurate.
- [ ] Public Notes are clear and useful (if provided).
- [ ] **Public** is checked if the venue should be live.
- [ ] A site rebuild is triggered if you want the change reflected in the static sitemap immediately.
