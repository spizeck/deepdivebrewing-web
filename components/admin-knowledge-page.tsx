"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { AdminAuthGate } from "@/components/admin-auth-gate";
import { Button } from "@/components/ui/button";
import { cn, pressableClasses } from "@/lib/utils";
import { formatAdminDateTime } from "@/lib/admin-format";
import {
  createKnowledgeApi,
  type KnowledgeApi,
  type KnowledgeApiUser,
} from "@/lib/knowledge-client";
import {
  KNOWLEDGE_CATEGORIES,
  knowledgeCategoryLabel,
  knowledgeDocumentTypeLabel,
  knowledgeStatusLabel,
  type KnowledgeArticleSummary,
  type KnowledgeSearchHit,
} from "@/lib/knowledge-common";

export function AdminKnowledgePage() {
  return (
    <AdminAuthGate
      heading="Knowledge Base"
      description="Sign in with an authorized Google account to read and manage internal SOPs."
    >
      {(user) => <KnowledgeLandingWithApi user={user} />}
    </AdminAuthGate>
  );
}

function KnowledgeLandingWithApi({ user }: { user: KnowledgeApiUser }) {
  const api = useMemo(() => createKnowledgeApi(user), [user]);
  return <KnowledgeLanding api={api} />;
}

const STATUS_BADGE_CLASSES: Record<string, string> = {
  published: "border-moss/40 bg-moss/10 text-moss",
  draft: "border-sand/50 bg-sand/15 text-ink",
  archived: "border-ink/20 bg-stone/40 text-muted-foreground",
};

export function KnowledgeStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        STATUS_BADGE_CLASSES[status] ?? "border-ink/20 text-muted-foreground"
      )}
    >
      {knowledgeStatusLabel(status)}
    </span>
  );
}

function ArticleRow({ article }: { article: KnowledgeArticleSummary }) {
  return (
    <li>
      <Link
        href={`/admin/knowledge/${article.slug}`}
        className={cn(
          "block rounded-lg border border-stone bg-paper p-4 hover:border-ink/30",
          pressableClasses
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-ink">{article.title}</span>
          <KnowledgeStatusBadge status={article.status} />
          <span className="text-xs text-muted-foreground">
            {knowledgeDocumentTypeLabel(article.documentType)}
            {article.version > 0 && ` · v${article.version}`}
          </span>
        </div>
        {article.summary && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {article.summary}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Updated {formatAdminDateTime(article.updatedAt)} by{" "}
          {article.updatedBy.name}
        </p>
      </Link>
    </li>
  );
}

// `api` is injected so the fixture page can render this component without
// Firebase (lib/knowledge-fixture.ts).
export function KnowledgeLanding({ api }: { api: KnowledgeApi }) {
  const [articles, setArticles] = useState<KnowledgeArticleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [queryText, setQueryText] = useState("");
  const [results, setResults] = useState<KnowledgeSearchHit[] | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listArticles()
      .then((list) => {
        if (!cancelled) setArticles(list);
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) setLoadError("Failed to load articles.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const trimmed = queryText.trim();
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(
      () => {
        if (!trimmed) {
          setResults(null);
          return;
        }
        api
          .searchArticles(trimmed)
          .then((hits) => {
            if (searchSeq.current === seq) setResults(hits);
          })
          .catch((error) => {
            console.error(error);
            if (searchSeq.current === seq) setResults([]);
          });
      },
      trimmed ? 250 : 0
    );
    return () => window.clearTimeout(timer);
  }, [queryText, api]);

  const byCategory = useMemo(() => {
    const map = new Map<string, KnowledgeArticleSummary[]>();
    for (const article of articles) {
      const list = map.get(article.category) ?? [];
      list.push(article);
      map.set(article.category, list);
    }
    return map;
  }, [articles]);

  const publishedCount = articles.filter((a) => a.status === "published").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Knowledge Base</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Internal SOPs, checklists, and reference docs — visible to
            authorized admins only.
          </p>
        </div>
        <Button asChild className="bg-ink/85 text-paper hover:bg-ink/75">
          <Link href="/admin/knowledge/new">
            <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
            New article
          </Link>
        </Button>
      </div>

      <div>
        <label htmlFor="kb-search" className="sr-only">
          Search the Knowledge Base
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id="kb-search"
            type="search"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Search titles, tags, and article text…"
            className="w-full rounded-md border border-ink/50 bg-paper py-2 pl-9 pr-3"
          />
        </div>
      </div>

      {loadError && (
        <p role="alert" className="text-sm text-ember">
          {loadError}
        </p>
      )}

      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading articles…
        </p>
      ) : results !== null ? (
        <section aria-label="Search results">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {results.length === 0
              ? "No results"
              : `${results.length} result${results.length === 1 ? "" : "s"}`}
          </h2>
          {results.length > 0 && (
            <ul className="mt-2 space-y-2">
              {results.map((hit) => (
                <li key={hit.article.slug}>
                  <Link
                    href={`/admin/knowledge/${hit.article.slug}`}
                    className={cn(
                      "block rounded-lg border border-stone bg-paper p-4 hover:border-ink/30",
                      pressableClasses
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-ink">
                        {hit.article.title}
                      </span>
                      <KnowledgeStatusBadge status={hit.article.status} />
                      <span className="text-xs text-muted-foreground">
                        {knowledgeCategoryLabel(hit.article.category)} ·{" "}
                        {knowledgeDocumentTypeLabel(hit.article.documentType)}
                      </span>
                    </div>
                    {hit.snippet && (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {hit.snippet}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : articles.length === 0 ? (
        <div className="rounded-lg border border-stone bg-paper p-6 text-sm text-muted-foreground">
          <p>No articles yet.</p>
          <p className="mt-1">
            Create the first SOP to start building the internal handbook.
          </p>
        </div>
      ) : (
        <>
          {publishedCount > 0 && (
            <section aria-label="Recently updated">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Recently updated
              </h2>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {articles.slice(0, 4).map((article) => (
                  <ArticleRow key={article.slug} article={article} />
                ))}
              </ul>
            </section>
          )}

          {KNOWLEDGE_CATEGORIES.filter((c) => byCategory.has(c)).map(
            (category) => (
              <section
                key={category}
                aria-label={knowledgeCategoryLabel(category)}
              >
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {knowledgeCategoryLabel(category)}
                </h2>
                <ul className="mt-2 space-y-2">
                  {(byCategory.get(category) ?? []).map((article) => (
                    <ArticleRow key={article.slug} article={article} />
                  ))}
                </ul>
              </section>
            )
          )}
        </>
      )}
    </div>
  );
}
