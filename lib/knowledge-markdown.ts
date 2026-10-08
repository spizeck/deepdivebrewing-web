/**
 * Markdown pipeline helpers for the Knowledge Base (#201) — pure functions,
 * safe to import from client components (no firebase/*).
 *
 * Two jobs:
 *  - `extractKnowledgeToc`: heading table of contents for the article rail,
 *    slugged with the same github-slugger algorithm rehype-slug applies to
 *    rendered headings, so TOC hrefs always match the DOM ids.
 *  - `remarkKnowledgeCallouts`: remark plugin that turns `:::note`-style
 *    container directives into callout markup handled by
 *    components/knowledge-article-body.tsx.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import { visit } from "unist-util-visit";
import GithubSlugger from "github-slugger";
import type { Root, Content, PhrasingContent, Parents } from "mdast";
import { KNOWLEDGE_CALLOUT_TYPES, type KnowledgeCalloutType } from "@/lib/knowledge-common";

export interface KnowledgeTocItem {
  depth: 2 | 3 | 4;
  id: string;
  text: string;
}

function toPlainText(node: Content | PhrasingContent | Parents): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as PhrasingContent[]).map(toPlainText).join("");
  }
  return "";
}

// remark-directive requires the bracketed label form `:::warning[Title]`;
// MkDocs-style `:::warning Title` reads more naturally to authors, so the
// source is normalized before parsing. Fences without trailing text and
// attribute blocks `{…}` are untouched.
const DIRECTIVE_TITLE_LINE =
  /^([ \t]*:{3,})([a-zA-Z-]+)[ \t]+([^\[{][^\n]*?)[ \t]*$/gm;

export function normalizeKnowledgeMarkdown(markdown: string): string {
  return markdown.replace(
    DIRECTIVE_TITLE_LINE,
    (_match, fence: string, name: string, title: string) =>
      `${fence}${name}[${title}]`
  );
}

const tocProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkDirective);

export function extractKnowledgeToc(markdown: string): KnowledgeTocItem[] {
  const tree = tocProcessor.parse(normalizeKnowledgeMarkdown(markdown)) as Root;
  // remark plugins only transform on .run(); parse() alone leaves directive
  // nodes unvisited — fine, headings inside callouts are collected below via
  // visit() over the whole tree regardless.
  const slugger = new GithubSlugger();
  const items: KnowledgeTocItem[] = [];

  visit(tree, "heading", (node) => {
    if (node.depth < 2 || node.depth > 4) return;
    const text = node.children.map(toPlainText).join("").trim();
    if (!text) return;
    items.push({
      depth: node.depth as 2 | 3 | 4,
      id: slugger.slug(text),
      text,
    });
  });

  return items;
}

// `:::note Optional title` — container directives (remark-directive). The
// label line becomes the callout title; the rest renders as normal flow
// content. Unknown directive names are left untouched (their children still
// render, the fence itself disappears).
export function remarkKnowledgeCallouts() {
  return (tree: Root) => {
    visit(tree, "containerDirective", (node) => {
      const name = node.name as KnowledgeCalloutType;
      if (!KNOWLEDGE_CALLOUT_TYPES.includes(name)) return;

      let title = name.charAt(0).toUpperCase() + name.slice(1);
      const first = node.children[0];
      if (
        first &&
        first.type === "paragraph" &&
        first.data?.directiveLabel === true
      ) {
        const custom = first.children.map(toPlainText).join("").trim();
        if (custom) title = custom;
        node.children = node.children.slice(1) as typeof node.children;
      }

      node.data = {
        ...node.data,
        hName: "aside",
        hProperties: {
          className: `kb-callout kb-callout-${name}`,
          "data-callout": name,
          "data-callout-title": title,
        },
      };
    });
  };
}
