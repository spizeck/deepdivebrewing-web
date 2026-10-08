"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  History,
  ListTree,
  Menu,
  Pencil,
  Printer,
} from "lucide-react";
import { AdminAuthGate } from "@/components/admin-auth-gate";
import { Button } from "@/components/ui/button";
import { cn, pressableClasses } from "@/lib/utils";
import { formatAdminDate, formatAdminDateTime } from "@/lib/admin-format";
import { KnowledgeArticleBody } from "@/components/knowledge-article-body";
import { KnowledgeNav } from "@/components/knowledge-nav";
import { KnowledgeToc } from "@/components/knowledge-toc";
import { KnowledgeStatusBadge } from "@/components/admin-knowledge-page";
import { extractKnowledgeToc } from "@/lib/knowledge-markdown";
import {
  createKnowledgeApi,
  type KnowledgeApi,
} from "@/lib/knowledge-client";
import {
  knowledgeCategoryLabel,
  knowledgeDocumentTypeLabel,
  type KnowledgeArticleSummary,
  type KnowledgeArticleView,
} from "@/lib/knowledge-common";

export function AdminKnowledgeArticlePage({ slug }: { slug: string }) {
  return (
    <AdminAuthGate
      heading="Knowledge Base"
      description="Sign in with an authorized Google account to read internal SOPs."
    >
      {(user) => (
        <KnowledgeArticleShell api={createKnowledgeApi(user)} slug={slug} />
      )}
    </AdminAuthGate>
  );
}

export function KnowledgeArticleShell({
  api,
  slug,
}: {
  api: KnowledgeApi;
  slug: string;
}) {
  const [article, setArticle] = useState<KnowledgeArticleView | null>(null);
  const [articles, setArticles] = useState<KnowledgeArticleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getArticle(slug), api.listArticles()])
      .then(([nextArticle, list]) => {
        if (cancelled) return;
        setArticle(nextArticle);
        setArticles(list);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError("Article not found or unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, slug]);

  const toc = useMemo(
    () => (article ? extractKnowledgeToc(article.bodyMarkdown) : []),
    [article]
  );

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading article…
      </p>
    );
  }

  if (error || !article) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-xl font-bold tracking-tight">Knowledge Base</h1>
        <p role="alert" className="mt-2 text-sm text-ember">
          {error || "Article not found."}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/admin/knowledge">Back to Knowledge Base</Link>
        </Button>
      </div>
    );
  }

  const nav = <KnowledgeNav articles={articles} activeSlug={article.slug} />;
  const tocNav = <KnowledgeToc items={toc} />;

  return (
    <div className="kb-print-root">
      {/* Print-only document header — hidden on screen, shown on paper. */}
      <div className="kb-print-only" aria-hidden="true">
        <p className="kb-print-brand">Deep Dive Brewing Co — Knowledge Base</p>
        <h1>{article.title}</h1>
        <p className="kb-print-meta">
          {knowledgeCategoryLabel(article.category)} ·{" "}
          {knowledgeDocumentTypeLabel(article.documentType)} · Version{" "}
          {article.version > 0 ? article.version : "—"} · Last updated{" "}
          {formatAdminDate(article.updatedAt)}
          {article.lastReviewedAt
            ? ` · Last reviewed ${formatAdminDate(article.lastReviewedAt)}`
            : ""}
        </p>
      </div>

      <div className="kb-print-grid grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)_220px]">
        {/* Left rail — desktop */}
        <aside className="kb-screen-only hidden lg:block">
          <div className="sticky top-28 max-h-[calc(100vh-8rem)] overflow-y-auto pr-1">
            <Link
              href="/admin/knowledge"
              className="mb-3 inline-block px-2 text-sm font-medium text-ocean hover:underline"
            >
              ← Knowledge Base
            </Link>
            {nav}
          </div>
        </aside>

        <article className="min-w-0">
          {/* Mobile nav + TOC disclosures */}
          <div className="kb-screen-only mb-4 space-y-2 lg:hidden">
            <details className="rounded-lg border border-stone bg-paper">
              <summary
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium",
                  pressableClasses
                )}
              >
                <Menu aria-hidden="true" className="h-4 w-4" />
                Browse Knowledge Base
              </summary>
              <div className="border-t border-stone p-3">{nav}</div>
            </details>
            {toc.length > 0 && (
              <details className="rounded-lg border border-stone bg-paper">
                <summary
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium",
                    pressableClasses
                  )}
                >
                  <ListTree aria-hidden="true" className="h-4 w-4" />
                  On this page
                </summary>
                <div className="border-t border-stone p-3">{tocNav}</div>
              </details>
            )}
          </div>

          <nav
            aria-label="Breadcrumb"
            className="kb-screen-only text-sm text-muted-foreground"
          >
            <ol className="flex flex-wrap items-center gap-1">
              <li>
                <Link href="/admin" className="hover:text-ink hover:underline">
                  Admin
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="inline h-3.5 w-3.5" />
              </li>
              <li>
                <Link
                  href="/admin/knowledge"
                  className="hover:text-ink hover:underline"
                >
                  Knowledge Base
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="inline h-3.5 w-3.5" />
              </li>
              <li>{knowledgeCategoryLabel(article.category)}</li>
              <li aria-hidden="true">
                <ChevronRight className="inline h-3.5 w-3.5" />
              </li>
              <li aria-current="page" className="font-medium text-ink">
                {article.title}
              </li>
            </ol>
          </nav>

          {article.status !== "published" && (
            <p
              role="status"
              className="kb-screen-only mt-4 rounded-md border border-amber-400/60 bg-amber-100/60 px-3 py-2 text-sm text-amber-900"
            >
              This article is {article.status} — only admins can see it.
            </p>
          )}

          <header className="kb-screen-only mt-4 border-b border-stone pb-5">
            <h1 className="text-3xl font-bold tracking-tight">
              {article.title}
            </h1>
            {article.summary && (
              <p className="mt-2 text-muted-foreground">{article.summary}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <KnowledgeStatusBadge status={article.status} />
              <span className="rounded-full border border-ink/20 px-2 py-0.5 font-medium">
                {knowledgeDocumentTypeLabel(article.documentType)}
              </span>
              <span>{knowledgeCategoryLabel(article.category)}</span>
              <span>
                {article.version > 0 ? `v${article.version}` : "Unpublished"}
              </span>
              <span>
                Updated {formatAdminDateTime(article.updatedAt)} by{" "}
                {article.updatedBy.name}
              </span>
              {article.lastReviewedAt && (
                <span>Reviewed {formatAdminDate(article.lastReviewedAt)}</span>
              )}
              {article.ownerRole && <span>Owner: {article.ownerRole}</span>}
            </div>
            {article.tags.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {article.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full bg-stone/40 px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/knowledge/${article.slug}/edit`}>
                  <Pencil aria-hidden="true" className="mr-1 h-4 w-4" />
                  Edit
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/knowledge/${article.slug}/history`}>
                  <History aria-hidden="true" className="mr-1 h-4 w-4" />
                  History
                </Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.print()}
              >
                <Printer aria-hidden="true" className="mr-1 h-4 w-4" />
                Print / Save PDF
              </Button>
            </div>
          </header>

          <KnowledgeArticleBody
            markdown={article.bodyMarkdown}
            className="mt-6"
          />
        </article>

        {/* Right rail TOC — desktop */}
        <aside className="kb-screen-only hidden xl:block">
          <div className="sticky top-28">{tocNav}</div>
        </aside>
      </div>
    </div>
  );
}
