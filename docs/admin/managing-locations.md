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
| **Island** | Yes | The island the venue is on. A controlled dropdown — pick one of the listed islands. This controls grouping and the Island filter on `/where-to-buy`. |
| **Location / locality** | Optional | A more specific place on the island, for example `Windwardside` or `Philipsburg`. Shown on the venue card next to the island. Leave blank if the island alone is enough. It never affects grouping. |
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

## Island and locality

The `/where-to-buy` page groups venues by the **Island** field — a controlled dropdown with exactly these options:

- **Saba**
- **Sint Maarten / Saint Martin**
- **Sint Eustatius / Statia**

Island is required; a venue cannot be saved without one, and free-text island names are impossible by design. (Internally the values are stored as `saba`, `sxm`, and `statia` — the internal codes never appear publicly.)

**Location / locality** is a separate, optional free-text field for a more specific place — `Windwardside`, `The Bottom`, `Fort Bay`, `Philipsburg`. It is shown on the venue card together with the island (for example `Windwardside, Saba` or `Philipsburg, Sint Maarten`) but never affects grouping or the Island filter. Leave it blank when the island alone is enough — the card then shows just the island label.

> **Why two fields?** Locality text used to double as the island, which let values like `Philipsburg` or `Windwardside` accidentally become their own public island group. Existing records now carry a separate canonical island and `locationName` holds only the locality; reads still understand the old combined format, so a stale record would not break the site.

## How locations appear on `/where-to-buy`

- Only venues with **Public** checked are shown.
- Venues are grouped under headings based on **Island**.
- Inside each group, venues are sorted by **Sort Order**.
- Each venue card shows the name, type badge, location, public notes, and the beers listed under **On Tap** and **In Can**.
- Links for Website, Directions, Instagram, and Facebook appear when those fields are filled.
- Visitors can filter the list by **Beer**, **Format** (On Tap / In Can), and — when venues span more than one island — **Island**. The beer filter only lists beers that at least one public venue carries; the format and island filters read the same **On Tap**, **In Can**, and **Island** fields described above, so keeping them accurate keeps the filters useful. These lists describe what a venue is known to carry — they are not live stock counts.

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
- [ ] Island is selected from the dropdown (required).
- [ ] Location / locality is filled in only if it adds useful context.
- [ ] Sort order is set.
- [ ] Website link is a full `https://` URL (if provided).
- [ ] Maps Link is a working URL that opens directions (if provided).
- [ ] Social links are full URLs (if provided).
- [ ] Beer selections (Carries, On Tap, In Can) are accurate.
- [ ] Public Notes are clear and useful (if provided).
- [ ] **Public** is checked if the venue should be live.
- [ ] A site rebuild is triggered if you want the change reflected in the static sitemap immediately.
