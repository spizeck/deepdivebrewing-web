# Publishing Updates

How to publish a brewery update — a beer release, a seasonal returning, a new
venue carrying Deep Dive, an announcement, or a behind-the-scenes story — to
`/updates` on the live site.

Updates are **authored in the repository**, not in the admin dashboard. There
is no CMS: an update is a small Markdown file plus one registry line, and it
goes live with the next deploy. The whole flow takes a few minutes.

## The 2-step recipe

### 1. Create the body file

Create `content/updates/<slug>.mdx`, where `<slug>` is the URL you want —
lowercase words joined by hyphens, e.g. `belgian-ipa-back-in-stock`.

```text
content/updates/new-england-ipa-returns.mdx
```

The file is plain Markdown — paragraphs, `##`/`###` headings, lists,
`---` dividers, and standard inline links to site paths all work, styled
like the About page. Do **not** put a top-level `#` heading in the body —
the page already renders the title. Example:

```mdx
The NEIPA is back on tap and in cans. This batch leans into ...
```

### 2. Register it

Open `content/updates/index.ts` and add an entry:

```ts
{
  slug: "new-england-ipa-returns",          // must match the .mdx filename
  title: "The NEIPA Is Back",
  publishedAt: "2026-10-12",                // YYYY-MM-DD — shown to readers
  summary:
    "The New England IPA returns to taps and cans around Saba this week.",
  image: {                                   // optional
    src: "/photos/my-photo.jpg",
    alt: "Cans of NEIPA on the canning line",
    caption: "This week's canning run.",     // optional
  },
  cta: { label: "Find a pour", href: "/where-to-buy" },  // optional
  loadBody: () => import("./new-england-ipa-returns.mdx"),
},
```

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `slug` | yes | lowercase letters/numbers/hyphens; equals the `.mdx` filename and becomes `/updates/<slug>` |
| `title` | yes | rendered as the page heading |
| `publishedAt` | yes | `YYYY-MM-DD`; controls ordering (newest leads the archive) and becomes the sitemap `lastmod` + structured-data `datePublished` |
| `summary` | yes | 1–2 sentences, max 220 chars; used on the archive, as the meta description, and in social cards |
| `image` | no | `src` (a `/photos/…` path or absolute `https` URL), `alt` (required when an image is set), `caption` (optional) |
| `cta` | no | `label` + `href` — a button at the end of the post |
| `draft` | no | `true` hides the post everywhere in production but keeps it previewable in `npm run dev` |

## Images

- Use real brewery photography in `public/photos/` — never stock images.
- New photos go in `public/photos/`; run `npm run optimize-assets` first if
  the file is large (see [Images and storage](../admin/images-and-storage.md)).
- Rendering goes through `next/image` automatically — set a good `alt` and
  don't worry about `sizes`.

## Preview before publishing

```bash
npm run dev   # then visit http://localhost:3000/updates
```

A `draft: true` entry renders in dev so you can check it end to end, but it
never appears on the live site — archive, sitemap, and detail page all treat
it as absent.

## Publishing

Publishing is just the normal code flow: commit the `.mdx` file plus the
registry entry, open a PR, merge. The production build statically generates
`/updates` and every `/updates/<slug>` page, so a merge deploys the new post
— no rebuild trigger, no Firebase record, nothing else to click.

## Guardrails

- **Do not invent announcements.** Only publish real beers, venues, dates,
  and events. If a detail isn't certain, leave it out.
- Entries are validated at build time — a malformed date, duplicate slug,
  missing alt text, or over-long summary fails `npm run build`/`npm test`
  with a message naming the field.
- Dates are real dates: `publishedAt` is what readers and crawlers see, so
  set it to when the post goes live, not when the event happened.
