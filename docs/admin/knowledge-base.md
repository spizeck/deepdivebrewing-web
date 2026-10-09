# Knowledge Base (SOPs)

The Knowledge Base is the brewery's internal handbook: SOPs, checklists,
reference docs, and policies. It lives inside the admin area at
`/admin/knowledge` and is visible only to authorized administrators — content
is enforced private server-side, not just hidden from navigation.

## Getting there

1. Sign in at https://deepdivebrewing.com/admin.
2. Click **Open knowledge base** on the dashboard, or go directly to
   `/admin/knowledge`.

## Creating an article

1. Click **New article**.
2. Fill in the fields:
   - **Title** — the display name. The slug is suggested from it.
   - **Slug** — the URL identifier (lowercase, hyphens). Set once; it cannot
     be changed after the article is created.
   - **Category** — one of the fixed categories (Brewery Operations,
     Brewing, Cleaning & Sanitation, Packaging, Equipment, Tours,
     Sales & Distribution, Accounting, Safety, Admin / IT).
   - **Document type** — SOP, Checklist, Reference, or Policy.
   - **Summary** — one line shown in lists and under the title.
   - **Tags** — comma-separated; used by search.
3. Write the body in Markdown in the **Write** tab. Switch to **Preview** at
   any time — the preview renders exactly like the published page.
4. **Save draft** stores work-in-progress. **Publish** makes it the live
   version and records a revision snapshot.

Every field is saved as plain readable Markdown — no deploy is needed to
publish or update an article.

## Markdown quick reference

```md
## Heading         — section (appears in the right-side table of contents)
### Subheading
**bold**  *italic*  `code`
- bullet        1. numbered step
- [ ] checklist item (renders as a checkbox)
- [x] checked item
[link text](https://example.com)
[internal article](/admin/knowledge/other-slug)
> blockquote
---              (horizontal rule)
| Col | Col |    (tables)
| --- | --- |
```

### Callouts

Callouts (admonitions) highlight important content. Start a block with
`:::type` and end it with `:::`. The line after `:::type` may optionally be
a custom title:

```md
:::note
Useful context.
:::

:::warning Mandatory PPE
Wear eye protection for this step.
:::
```

Available types: `note`, `info`, `tip`, `warning`, `danger`. Each renders
with its own icon, color, and label. Plain `>` blockquotes stay visually
distinct — use them for quotes, not alerts.

### Images and attachments

Use the **Upload image** toolbar button (or attach a PDF) while editing.
Files are stored in Firebase Storage under `knowledge/<slug>/` and inserted
as `kb:` references, e.g. `![Diagram](kb:my-sop/valve.jpg)` or
`[Manual](kb:my-sop/manual.pdf)`. Attachments require admin access to view,
like the articles themselves.

The **Attachments** toolbar button lists every file already stored for the
article — including uploads whose Markdown reference was later removed.
Select **Insert** to reuse one: images insert as `![name](kb:…)`, other
files (PDFs) as `[name](kb:…)` links.

Deleting the Markdown line only detaches a file from the draft — the object
stays in Storage. To remove it permanently, use **Delete** in the
Attachments panel and confirm. Deletion is blocked while the file is still
referenced by the draft, any article's stored body, or any saved version in
History — a `kb:` link in one article can point at another article's
files, so the check is corpus-wide and published snapshots never lose their
images. Unreferenced files are kept — they remain available to reinsert or
delete later.

## Publishing and versions

- **Save draft** — stores edits without publishing (for drafts). Saving a
  *published* article republishes it and records a new revision, so the live
  content is always covered by version history.
- **Publish** — promotes a draft or archived article; bumps the version and
  snapshots the content.
- **Archive** — removes the article from the main lists without deleting it.
  Publishing an archived article restores it.
- **History** (`/admin/knowledge/<slug>/history`) — lists every published
  revision (`v001`, `v002`, …) with who published it and when. Expand a
  revision to view its rendered content, or **Restore** to copy a previous
  version back onto the article (a published article records the restore as
  a new revision — nothing is ever lost).

## Printing / Save as PDF

Open the published article and click **Print / Save PDF** — or use the
browser's print. The print stylesheet hides navigation, sidebars, and
controls; the paper copy shows the Deep Dive name, article title, category,
document type, version, and last-updated date, then the full body. This is
the intended way to produce a clean copy for external contacts:
**Print → Destination: Save as PDF**.

## Finding things

- The landing page search covers title, summary, tags, category, and body
  text.
- On an article, the left rail lists every article grouped by category; the
  right rail is a clickable table of contents generated from the article's
  headings. On mobile both collapse into "Browse Knowledge Base" and
  "On this page" disclosures.

## Access control

- All routes sit under `/admin` and require an authorized admin session —
  the same custom-claims + active `adminUsers` record check as the rest of
  the admin area, enforced by `requireAdminActor` on every
  `/api/admin/knowledge*` call.
- The `knowledgeArticles` collection (and its `versions` subcollection) is
  deny-all to client access in `firestore.rules`; all reads and writes go
  through the server routes.
- `knowledge/` Storage objects are excluded from the bucket's public-read
  rule and limited to active admins in `storage.rules`.
- All Knowledge Base routes are `noindex`, excluded from `robots.txt` and
  the sitemap, and use generic metadata so article titles never leak into
  crawlable pages.
