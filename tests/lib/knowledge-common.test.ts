import { describe, it } from "node:test";
import assert from "node:assert";
import {
  extractKnowledgeAttachmentPaths,
  isKnowledgeAttachmentName,
  isKnowledgeImageAttachment,
  isKnowledgeSlug,
  knowledgeDocumentTitle,
  knowledgeMarkdownReferencesAttachment,
  normalizeTags,
  parseKnowledgeInput,
  searchKnowledgeArticles,
  serializeKnowledgeArticle,
  serializeKnowledgeVersion,
  slugifyKnowledgeTitle,
  toKnowledgeSummary,
  type KnowledgeArticleView,
} from "@/lib/knowledge-common";

function article(overrides: Partial<KnowledgeArticleView> = {}): KnowledgeArticleView {
  return {
    title: "Fermenter CIP",
    slug: "fermenter-cip",
    summary: "Clean-in-place procedure for unitanks.",
    category: "cleaning-sanitation",
    documentType: "sop",
    tags: ["cip", "fermenter"],
    bodyMarkdown: "## Steps\n\n1. Rinse\n2. Circulate caustic\n",
    status: "published",
    version: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: { uid: "u1", name: "Admin" },
    updatedAt: "2026-01-02T00:00:00.000Z",
    updatedBy: { uid: "u1", name: "Admin" },
    publishedAt: "2026-01-02T00:00:00.000Z",
    publishedBy: { uid: "u1", name: "Admin" },
    lastReviewedAt: null,
    ownerRole: "",
    ...overrides,
  };
}

describe("slugifyKnowledgeTitle", () => {
  it("normalizes titles into URL-safe slugs", () => {
    assert.strictEqual(
      slugifyKnowledgeTitle("Fermenter CIP — Caustic & Rinse!"),
      "fermenter-cip-caustic-rinse"
    );
    assert.strictEqual(slugifyKnowledgeTitle("  Kegging   Day "), "kegging-day");
    assert.strictEqual(slugifyKnowledgeTitle("Chad's List"), "chads-list");
    assert.strictEqual(slugifyKnowledgeTitle("!!!"), "");
  });
});

describe("isKnowledgeSlug", () => {
  it("accepts lowercase hyphenated slugs", () => {
    assert.ok(isKnowledgeSlug("fermenter-cip"));
    assert.ok(isKnowledgeSlug("a"));
    assert.ok(isKnowledgeSlug("sop-2024-01"));
  });

  it("rejects invalid slugs", () => {
    for (const bad of ["", "UPPER", "has space", "-lead", "trail-", "a--b", "under_score", "x".repeat(81)]) {
      assert.strictEqual(isKnowledgeSlug(bad), false, bad);
    }
  });
});

describe("parseKnowledgeInput", () => {
  const valid = {
    title: "Fermenter CIP",
    slug: "fermenter-cip",
    summary: "Clean-in-place.",
    category: "cleaning-sanitation",
    documentType: "sop",
    tags: ["CIP", " fermenter ", ""],
    bodyMarkdown: "## Steps\n\n1. Rinse",
  };

  it("accepts a valid payload and normalizes tags", () => {
    const parsed = parseKnowledgeInput(valid);
    assert.ok(parsed.ok);
    assert.deepStrictEqual(parsed.input.tags, ["cip", "fermenter"]);
    assert.strictEqual(parsed.input.category, "cleaning-sanitation");
  });

  it("rejects missing title, bad slug, bad category, empty body", () => {
    assert.strictEqual(parseKnowledgeInput({ ...valid, title: " " }).ok, false);
    assert.strictEqual(parseKnowledgeInput({ ...valid, slug: "Bad Slug" }).ok, false);
    assert.strictEqual(parseKnowledgeInput({ ...valid, category: "nope" }).ok, false);
    assert.strictEqual(parseKnowledgeInput({ ...valid, documentType: "memo" }).ok, false);
    assert.strictEqual(parseKnowledgeInput({ ...valid, bodyMarkdown: "  " }).ok, false);
    assert.strictEqual(parseKnowledgeInput("nope").ok, false);
  });
});

describe("normalizeTags", () => {
  it("lowercases, trims, dedupes, and drops non-strings", () => {
    assert.deepStrictEqual(
      normalizeTags(["CIP", "cip", " Safety ", 42, null]),
      ["cip", "safety"]
    );
    assert.deepStrictEqual(normalizeTags("nope"), []);
  });
});

describe("serializeKnowledgeArticle", () => {
  it("converts Timestamp-like values to ISO strings", () => {
    const ts = { toMillis: () => 1735689600000 };
    const view = serializeKnowledgeArticle({
      title: "T",
      slug: "t",
      summary: "",
      category: "safety",
      documentType: "policy",
      tags: [],
      bodyMarkdown: "body",
      status: "published",
      version: 3,
      createdAt: ts,
      createdBy: { uid: "u", name: "A" },
      updatedAt: ts,
      updatedBy: { uid: "u", name: "A" },
      publishedAt: ts,
      publishedBy: { uid: "u", name: "A" },
    });
    assert.strictEqual(view.createdAt, "2025-01-01T00:00:00.000Z");
    assert.strictEqual(view.publishedAt, "2025-01-01T00:00:00.000Z");
    assert.strictEqual(view.version, 3);
  });

  it("falls back safely for missing fields", () => {
    const view = serializeKnowledgeArticle({});
    assert.strictEqual(view.status, "draft");
    assert.strictEqual(view.version, 0);
    assert.strictEqual(view.title, "");
    assert.deepStrictEqual(view.tags, []);
  });
});

describe("serializeKnowledgeVersion", () => {
  it("serializes a stored snapshot", () => {
    const view = serializeKnowledgeVersion("v002", {
      version: 2,
      snapshot: {
        title: "Old title",
        slug: "s",
        summary: "s",
        category: "brewing",
        documentType: "checklist",
        tags: ["a"],
        bodyMarkdown: "old body",
      },
      changedAt: 1735689600000,
      changedBy: { uid: "u", name: "Admin" },
      changeType: "restore",
    });
    assert.strictEqual(view.versionId, "v002");
    assert.strictEqual(view.version, 2);
    assert.strictEqual(view.snapshot.title, "Old title");
    assert.strictEqual(view.snapshot.bodyMarkdown, "old body");
    assert.strictEqual(view.changeType, "restore");
    assert.strictEqual(view.changedAt, "2025-01-01T00:00:00.000Z");
  });
});

describe("searchKnowledgeArticles", () => {
  const corpus = [
    article(),
    article({
      slug: "tour-checklist",
      title: "Tour Checklist",
      summary: "Before guests arrive.",
      category: "tours",
      documentType: "checklist",
      tags: ["tours"],
      bodyMarkdown: "## Morning\n\n- [ ] Check taps\n",
    }),
    article({
      slug: "draft-sop",
      title: "Draft SOP",
      status: "draft",
      version: 0,
      publishedAt: null,
      bodyMarkdown: "secret draft text",
    }),
  ];

  it("matches title, tags, category, and body", () => {
    assert.strictEqual(
      searchKnowledgeArticles(corpus, "fermenter")[0].article.slug,
      "fermenter-cip"
    );
    assert.strictEqual(
      searchKnowledgeArticles(corpus, "checklist")[0].article.slug,
      "tour-checklist"
    );
    assert.strictEqual(
      searchKnowledgeArticles(corpus, "caustic")[0].article.slug,
      "fermenter-cip"
    );
    assert.strictEqual(
      searchKnowledgeArticles(corpus, "secret draft")[0].article.slug,
      "draft-sop"
    );
  });

  it("ranks title matches above body matches", () => {
    const results = searchKnowledgeArticles(corpus, "tour");
    assert.strictEqual(results[0].article.slug, "tour-checklist");
  });

  it("returns empty for blank or unmatched queries", () => {
    assert.deepStrictEqual(searchKnowledgeArticles(corpus, ""), []);
    assert.deepStrictEqual(searchKnowledgeArticles(corpus, "zzzzz"), []);
  });

  it("excludes body markdown from the returned summaries", () => {
    const hit = searchKnowledgeArticles(corpus, "fermenter")[0];
    assert.ok(hit);
    assert.strictEqual("bodyMarkdown" in hit.article, false);
    assert.deepStrictEqual(
      toKnowledgeSummary(corpus[0]).slug,
      "fermenter-cip"
    );
    assert.strictEqual("bodyMarkdown" in toKnowledgeSummary(corpus[0]), false);
  });
});

describe("extractKnowledgeAttachmentPaths", () => {
  it("finds image and link kb: references", () => {
    const md = [
      "![diagram](kb:keg-washer/1700-diagram.png)",
      "[manual](kb:keg-washer/1701-manual.pdf)",
      "see kb:keg-washer/1700-diagram.png inline",
      "other article: ![x](kb:other-sop/other.png)",
    ].join("\n");
    assert.deepStrictEqual(
      extractKnowledgeAttachmentPaths(md).sort(),
      [
        "keg-washer/1700-diagram.png",
        "keg-washer/1701-manual.pdf",
        "other-sop/other.png",
      ]
    );
  });

  it("returns empty for bodies without references", () => {
    assert.deepStrictEqual(extractKnowledgeAttachmentPaths(""), []);
    assert.deepStrictEqual(
      extractKnowledgeAttachmentPaths("![x](https://a/b.png) [y](/z)"),
      []
    );
  });
});

describe("knowledgeMarkdownReferencesAttachment", () => {
  const slug = "keg-washer";

  it("matches image and link references for the same slug", () => {
    assert.ok(
      knowledgeMarkdownReferencesAttachment(
        "![d](kb:keg-washer/a.png)",
        slug,
        "a.png"
      )
    );
    assert.ok(
      knowledgeMarkdownReferencesAttachment(
        "[m](kb:keg-washer/b.pdf)",
        slug,
        "b.pdf"
      )
    );
  });

  it("ignores references to other slugs or other files", () => {
    const md = "![d](kb:keg-washer/a.png) ![o](kb:other/a.png)";
    assert.strictEqual(
      knowledgeMarkdownReferencesAttachment(md, slug, "missing.png"),
      false
    );
    assert.strictEqual(
      knowledgeMarkdownReferencesAttachment(md, "other-article", "a.png"),
      false
    );
    assert.ok(knowledgeMarkdownReferencesAttachment(md, "other", "a.png"));
  });

  it("still matches when prose punctuation follows the reference", () => {
    assert.ok(
      knowledgeMarkdownReferencesAttachment(
        "See the diagram (kb:keg-washer/a.png).",
        slug,
        "a.png"
      )
    );
  });
});

describe("isKnowledgeAttachmentName", () => {
  it("accepts storage basenames", () => {
    assert.ok(isKnowledgeAttachmentName("1700000000000-photo.jpg"));
    assert.ok(isKnowledgeAttachmentName("manual.pdf"));
  });

  it("rejects anything that could leave the article prefix", () => {
    for (const bad of [
      "",
      "a/b.png",
      "../secret",
      "..",
      ".",
      ".hidden",
      "a\\b.png",
      "has space.png",
      "x".repeat(201),
    ]) {
      assert.strictEqual(isKnowledgeAttachmentName(bad), false, bad);
    }
  });
});

describe("isKnowledgeImageAttachment", () => {
  it("uses content type first and falls back to extension", () => {
    assert.ok(isKnowledgeImageAttachment("image/png", "a.bin"));
    assert.ok(isKnowledgeImageAttachment("", "diagram.JPG"));
    assert.strictEqual(
      isKnowledgeImageAttachment("application/pdf", "manual.pdf"),
      false
    );
    assert.strictEqual(isKnowledgeImageAttachment("", "notes.txt"), false);
  });
});

describe("knowledgeDocumentTitle", () => {
  it("names the tab/PDF after the article (published and draft alike)", () => {
    assert.strictEqual(
      knowledgeDocumentTitle("Fermenter CIP"),
      "Fermenter CIP | Knowledge Base | Deep Dive Brewing Co"
    );
    assert.strictEqual(
      knowledgeDocumentTitle(article({ status: "draft" }).title),
      "Fermenter CIP | Knowledge Base | Deep Dive Brewing Co"
    );
  });

  it("trims surrounding whitespace", () => {
    assert.strictEqual(
      knowledgeDocumentTitle("  Fermenter CIP  "),
      "Fermenter CIP | Knowledge Base | Deep Dive Brewing Co"
    );
  });

  it("falls back to a generic title when the title is missing", () => {
    assert.strictEqual(
      knowledgeDocumentTitle("   "),
      "Article — Knowledge Base | Deep Dive Brewing Co"
    );
    assert.strictEqual(
      knowledgeDocumentTitle(""),
      "Article — Knowledge Base | Deep Dive Brewing Co"
    );
  });
});
