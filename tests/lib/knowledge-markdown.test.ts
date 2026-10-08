import { describe, it } from "node:test";
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  extractKnowledgeToc,
  remarkKnowledgeCallouts,
} from "@/lib/knowledge-markdown";
import { KnowledgeArticleBody } from "@/components/knowledge-article-body";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(KnowledgeArticleBody, { markdown })
  );
}

describe("extractKnowledgeToc", () => {
  it("collects h2–h4 with stable slugs", () => {
    const toc = extractKnowledgeToc(
      "# Title\n\n## First Section\n\n### Sub A\n\n#### Deep\n\n##### Too deep\n"
    );
    assert.deepStrictEqual(
      toc.map((t) => [t.depth, t.id, t.text]),
      [
        [2, "first-section", "First Section"],
        [3, "sub-a", "Sub A"],
        [4, "deep", "Deep"],
      ]
    );
  });

  it("dedupes repeated heading slugs the same way the renderer does", () => {
    const toc = extractKnowledgeToc("## Setup\n\n## Setup\n");
    assert.strictEqual(toc[0].id, "setup");
    assert.strictEqual(toc[1].id, "setup-1");
  });

  it("ignores headings inside fenced code", () => {
    const toc = extractKnowledgeToc("## Real\n\n```md\n## Fake\n```\n");
    assert.strictEqual(toc.length, 1);
    assert.strictEqual(toc[0].id, "real");
  });
});

describe("knowledge article rendering", () => {
  it("renders headings with slug ids for the TOC", () => {
    const html = render("## Step One\n\n## Step One\n");
    assert.match(html, /id="step-one"/);
    assert.match(html, /id="step-one-1"/);
  });

  it("renders note and warning callouts with labels", () => {
    const html = render(
      ":::warning Custom Title\nBody text.\n:::\n\n:::note\nNote body.\n:::\n"
    );
    assert.match(html, /kb-callout-warning/);
    assert.match(html, /kb-callout-note/);
    assert.match(html, /Custom Title/);
    assert.match(html, />Note</);
    assert.match(html, /Body text\./);
  });

  it("renders GFM tables and task lists", () => {
    const html = render(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] todo\n- [x] done\n"
    );
    assert.match(html, /<table>/);
    assert.match(html, /<td>1<\/td>/);
    assert.match(html, /type="checkbox"[^>]*disabled/);
    assert.match(html, /checked/);
  });

  it("escapes raw HTML and script tags", () => {
    const html = render(
      "<script>alert(1)</script>\n\n<div onclick=\"x()\">hi</div>\n"
    );
    // Raw markup is escaped as text — no live elements, no event handlers.
    assert.ok(!html.includes("<script>"), html);
    assert.ok(!html.includes('<div onclick="x()"'), html);
    assert.match(html, /alert\(1\)/);
  });

  it("strips dangerous link protocols", () => {
    const html = render("[x](javascript:alert(1))\n\n![y](javascript:bad)\n");
    assert.ok(!html.includes('href="javascript:'), html);
    assert.ok(!html.includes('src="javascript:'), html);
  });

  it("keeps safe links, internal links, and kb: attachment refs", () => {
    const html = render(
      "[site](https://example.com)\n\n[internal](/admin/knowledge/other)\n\n[manual.pdf](kb:example-sop/manual.pdf)\n\n![pic](kb:example-sop/photo.png)\n"
    );
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /href="\/admin\/knowledge\/other"/);
    // kb: refs resolve client-side — fixture-less rendering shows the
    // pending/fallback state rather than a raw broken link.
    assert.match(html, /manual\.pdf/);
    assert.match(html, /Loading image/);
  });

  it("leaves unknown directives' content readable", () => {
    const html = render(":::mystery\nContent stays.\n:::\n");
    assert.match(html, /Content stays\./);
  });
});

describe("remarkKnowledgeCallouts", () => {
  it("is a remark transformer factory", () => {
    assert.strictEqual(typeof remarkKnowledgeCallouts(), "function");
  });
});
