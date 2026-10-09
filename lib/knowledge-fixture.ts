import {
  KnowledgeApiError,
  type KnowledgeApi,
  type KnowledgeVersionListItem,
} from "@/lib/knowledge-client";
import {
  knowledgeMarkdownReferencesAttachment,
  searchKnowledgeArticles,
  toKnowledgeSummary,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeArticleView as View,
  type KnowledgeVersionView,
} from "@/lib/knowledge-common";

/**
 * Deterministic fixture data + in-memory KnowledgeApi for the test-only
 * /admin-knowledge-fixture route (#201). Lets the smoke suite and local
 * review exercise the real components — landing, editor preview, published
 * view with callouts/TOC, and history — without Firebase.
 *
 * The example SOP below is deliberately generic: it demonstrates formatting
 * (headings, numbered steps, checklist, callouts, table) and must never be
 * treated as real brewery procedure.
 */

export const EXAMPLE_SOP_MARKDOWN = `Example SOP — the content below is a formatting demonstration, not a real procedure.

## Purpose

Demonstrates how a standard operating procedure reads in the Knowledge Base, including callouts, checklists, and tables.

## Before you begin

- [ ] Confirm you have permission to perform this task
- [ ] Gather required tools and protective equipment
- [ ] Review the related checklist

:::note Example note
Callouts highlight context. This example uses the \`note\` style.
:::

:::warning Example warning
Warning callouts mark steps where a mistake could cause injury or product loss. Replace this text with real guidance.
:::

## Procedure

1. Read the entire procedure before starting.
2. Complete each step in order.
3. Record completion in the log.

### Step detail

Steps may have subsections, **bold** key actions, *italic* emphasis, and links to [related articles](/admin/knowledge).

| Parameter | Example value | Notes |
| --- | --- | --- |
| Temperature | 68 °F | Placeholder only |
| Time | 20 min | Placeholder only |

:::tip Example tip
Tips capture shortcuts and lessons learned.
:::

:::danger Example danger
Danger callouts mark severe hazards. Replace with real safety information before publishing a real SOP.
:::

> A plain blockquote stays visually distinct from callouts.

## Records

Note where records are filed and who is responsible.
`;

const now = Date.now();
const actor = { uid: "fixture-user", name: "Fixture Admin" };

function fixtureArticle(
  input: KnowledgeArticleInput,
  overrides: Partial<KnowledgeArticleView> = {}
): KnowledgeArticleView {
  return {
    ...input,
    status: "published",
    version: 1,
    createdAt: new Date(now - 30 * 86400000).toISOString(),
    createdBy: actor,
    updatedAt: new Date(now - 2 * 86400000).toISOString(),
    updatedBy: actor,
    publishedAt: new Date(now - 2 * 86400000).toISOString(),
    publishedBy: actor,
    lastReviewedAt: null,
    ownerRole: "",
    ...overrides,
  };
}

export function buildFixtureArticles(): KnowledgeArticleView[] {
  return [
    fixtureArticle(
      {
        title: "Example SOP: Formatting Reference",
        slug: "example-sop",
        summary:
          "Demonstrates headings, steps, checklists, tables, and callouts. Not a real procedure.",
        category: "brewery-operations",
        documentType: "sop",
        tags: ["example", "template"],
        bodyMarkdown: EXAMPLE_SOP_MARKDOWN,
      },
      { version: 2 }
    ),
    fixtureArticle(
      {
        title: "Example Checklist: Opening Duties",
        slug: "example-opening-checklist",
        summary: "Placeholder checklist showing the checklist document type.",
        category: "tours",
        documentType: "checklist",
        tags: ["example"],
        bodyMarkdown:
          "## Opening\n\n- [ ] Example item one\n- [ ] Example item two\n",
      },
      { updatedAt: new Date(now - 5 * 86400000).toISOString() }
    ),
    fixtureArticle(
      {
        title: "Example Draft Reference",
        slug: "example-draft-reference",
        summary: "Unpublished draft visible to admins only.",
        category: "safety",
        documentType: "reference",
        tags: [],
        bodyMarkdown: "## Placeholder\n\nDraft body text.\n",
      },
      { status: "draft", version: 0, publishedAt: null, publishedBy: null }
    ),
  ];
}

export function buildFixtureVersions(
  article: KnowledgeArticleView
): KnowledgeVersionListItem[] {
  if (article.version === 0) return [];
  return Array.from({ length: article.version }, (_, i) => {
    const version = article.version - i;
    return {
      versionId: `v${String(version).padStart(3, "0")}`,
      version,
      snapshotTitle: article.title,
      snapshotSummary: article.summary,
      changedAt: new Date(now - (version + 2) * 86400000).toISOString(),
      changedBy: actor,
      changeType: version === 1 ? "publish" : "restore",
    } as KnowledgeVersionListItem;
  });
}

interface FixtureAttachment {
  slug: string;
  name: string;
  size: number;
  contentType: string;
  updatedAt: string;
}

export function createFixtureKnowledgeApi(): KnowledgeApi {
  const articles = buildFixtureArticles();
  // In-memory stand-ins for objects under knowledge/<slug>/. No Markdown in
  // the fixtures references them, so `referenced` is false until a test types
  // a kb: link into the draft — the same check the server performs.
  const attachments: FixtureAttachment[] = [
    {
      slug: "example-sop",
      name: "1700000000000-keg-washer.jpg",
      size: 812_345,
      contentType: "image/jpeg",
      updatedAt: new Date(now - 86400000).toISOString(),
    },
    {
      slug: "example-sop",
      name: "1700000001000-cip-checklist.pdf",
      size: 45_678,
      contentType: "application/pdf",
      updatedAt: new Date(now - 43200000).toISOString(),
    },
  ];

  return {
    listArticles: async () => articles.map(toKnowledgeSummary),
    searchArticles: async (queryText) =>
      searchKnowledgeArticles(articles, queryText),
    getArticle: async (slug) => {
      const found = articles.find((a) => a.slug === slug);
      if (!found) throw new Error("Article not found.");
      return found;
    },
    createArticle: async () => {
      throw new Error("Fixture is read-only.");
    },
    updateArticle: async () => {
      throw new Error("Fixture is read-only.");
    },
    publishArticle: async () => {
      throw new Error("Fixture is read-only.");
    },
    archiveArticle: async () => {
      throw new Error("Fixture is read-only.");
    },
    listVersions: async (slug) => {
      const found = articles.find((a) => a.slug === slug);
      if (!found) throw new Error("Article not found.");
      return buildFixtureVersions(found);
    },
    getVersion: async (slug, versionId): Promise<KnowledgeVersionView> => {
      const found = articles.find((a) => a.slug === slug);
      if (!found) throw new Error("Article not found.");
      const list = buildFixtureVersions(found);
      const meta = list.find((v) => v.versionId === versionId);
      if (!meta) throw new Error("Version not found.");
      const view: View = found;
      return {
        versionId: meta.versionId,
        version: meta.version,
        snapshot: {
          title: view.title,
          slug: view.slug,
          summary: view.summary,
          category: view.category,
          documentType: view.documentType,
          tags: view.tags,
          bodyMarkdown: view.bodyMarkdown,
        },
        changedAt: meta.changedAt,
        changedBy: meta.changedBy,
        changeType: meta.changeType,
      };
    },
    restoreVersion: async () => {
      throw new Error("Fixture is read-only.");
    },
    uploadAttachment: async () => {
      throw new Error("Uploads are disabled in the fixture.");
    },
    listAttachments: async (slug) => {
      const bodies = articles
        .filter((a) => a.slug === slug)
        .map((a) => a.bodyMarkdown);
      return attachments
        .filter((a) => a.slug === slug)
        .map((a) => ({
          name: a.name,
          size: a.size,
          contentType: a.contentType,
          updatedAt: a.updatedAt,
          referenced: bodies.some((body) =>
            knowledgeMarkdownReferencesAttachment(body, slug, a.name)
          ),
        }));
    },
    deleteAttachment: async (slug, name) => {
      const index = attachments.findIndex(
        (a) => a.slug === slug && a.name === name
      );
      if (index === -1) {
        throw new KnowledgeApiError("Attachment not found.", 404);
      }
      const bodies = articles
        .filter((a) => a.slug === slug)
        .map((a) => a.bodyMarkdown);
      if (
        bodies.some((body) =>
          knowledgeMarkdownReferencesAttachment(body, slug, name)
        )
      ) {
        throw new KnowledgeApiError(
          `"${name}" is still referenced by the article or a saved version.`,
          409
        );
      }
      attachments.splice(index, 1);
    },
  };
}
