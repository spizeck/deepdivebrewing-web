import Link from "next/link";
import { cn, pressableClasses } from "@/lib/utils";
import {
  KNOWLEDGE_CATEGORIES,
  knowledgeCategoryLabel,
  type KnowledgeArticleSummary,
} from "@/lib/knowledge-common";

/**
 * Left navigation rail for the Knowledge Base (#201): articles grouped by
 * category in a fixed taxonomy order. Rendered inline on desktop and inside
 * a collapsible disclosure on mobile by the caller.
 */
export function KnowledgeNav({
  articles,
  activeSlug,
}: {
  articles: KnowledgeArticleSummary[];
  activeSlug?: string;
}) {
  const byCategory = new Map<string, KnowledgeArticleSummary[]>();
  for (const article of articles) {
    const list = byCategory.get(article.category) ?? [];
    list.push(article);
    byCategory.set(article.category, list);
  }
  const categories = KNOWLEDGE_CATEGORIES.filter((c) => byCategory.has(c));

  if (categories.length === 0) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        No articles yet — create the first SOP.
      </p>
    );
  }

  return (
    <nav aria-label="Knowledge Base sections" className="space-y-4">
      {categories.map((category) => (
        <div key={category}>
          <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {knowledgeCategoryLabel(category)}
          </h3>
          <ul className="mt-1 space-y-0.5">
            {(byCategory.get(category) ?? []).map((article) => (
              <li key={article.slug}>
                <Link
                  href={`/admin/knowledge/${article.slug}`}
                  aria-current={activeSlug === article.slug ? "page" : undefined}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm",
                    activeSlug === article.slug
                      ? "bg-stone/50 font-medium text-ink"
                      : "text-ink/80 hover:bg-stone/25",
                    pressableClasses
                  )}
                >
                  <span className="truncate">{article.title}</span>
                  {article.status !== "published" && (
                    <span className="shrink-0 rounded-full border border-ink/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {article.status}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
