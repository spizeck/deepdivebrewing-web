"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, RotateCcw } from "lucide-react";
import { AdminAuthGate } from "@/components/admin-auth-gate";
import { Button } from "@/components/ui/button";
import { cn, pressableClasses } from "@/lib/utils";
import { formatAdminDateTime } from "@/lib/admin-format";
import { KnowledgeArticleBody } from "@/components/knowledge-article-body";
import {
  createKnowledgeApi,
  KnowledgeApiError,
  type KnowledgeApi,
  type KnowledgeApiUser,
  type KnowledgeVersionListItem,
} from "@/lib/knowledge-client";
import type { KnowledgeVersionView } from "@/lib/knowledge-common";

export function AdminKnowledgeHistoryPage({ slug }: { slug: string }) {
  return (
    <AdminAuthGate
      heading="Knowledge Base History"
      description="Sign in with an authorized Google account to view revision history."
    >
      {(user) => <KnowledgeHistoryWithApi user={user} slug={slug} />}
    </AdminAuthGate>
  );
}

function KnowledgeHistoryWithApi({
  user,
  slug,
}: {
  user: KnowledgeApiUser;
  slug: string;
}) {
  const api = useMemo(() => createKnowledgeApi(user), [user]);
  return <KnowledgeHistory api={api} slug={slug} />;
}

export function KnowledgeHistory({
  api,
  slug,
}: {
  api: KnowledgeApi;
  slug: string;
}) {
  const router = useRouter();
  const [versions, setVersions] = useState<KnowledgeVersionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, KnowledgeVersionView | "loading">>({});
  const [restoring, setRestoring] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listVersions(slug)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError("Failed to load version history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, slug]);

  async function toggleVersion(versionId: string) {
    if (expanded[versionId]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[versionId];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({ ...prev, [versionId]: "loading" }));
    try {
      const version = await api.getVersion(slug, versionId);
      setExpanded((prev) => ({ ...prev, [versionId]: version }));
    } catch {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[versionId];
        return next;
      });
      setStatusMessage("Failed to load that revision.");
    }
  }

  async function handleRestore(version: KnowledgeVersionListItem) {
    if (
      !window.confirm(
        `Restore v${version.version} content onto this article? Published articles record the restore as a new revision.`
      )
    ) {
      return;
    }
    setRestoring(version.versionId);
    setStatusMessage("");
    try {
      const article = await api.restoreVersion(slug, version.versionId);
      router.push(`/admin/knowledge/${article.slug}/edit`);
    } catch (err) {
      setStatusMessage(
        err instanceof KnowledgeApiError ? err.message : "Restore failed."
      );
      setRestoring("");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/admin/knowledge/${slug}`}
            className="text-ocean hover:underline"
          >
            ← Back to article
          </Link>
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          Revision history — <span className="font-mono text-xl">{slug}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every publish records an immutable snapshot. Restoring copies a
          snapshot back onto the article.
        </p>
      </div>

      {statusMessage && (
        <p role="status" className="text-sm text-ocean">
          {statusMessage}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-ember">
          {error}
        </p>
      )}

      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading history…
        </p>
      ) : versions.length === 0 ? (
        <p className="rounded-lg border border-stone bg-paper p-6 text-sm text-muted-foreground">
          No published revisions yet — snapshots appear after the first
          publish.
        </p>
      ) : (
        <ol className="space-y-3">
          {versions.map((version) => {
            const open = expanded[version.versionId];
            return (
              <li
                key={version.versionId}
                className="rounded-lg border border-stone bg-paper"
              >
                <div className="flex flex-wrap items-center gap-3 p-4">
                  <button
                    type="button"
                    onClick={() => void toggleVersion(version.versionId)}
                    aria-expanded={Boolean(open)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 text-left",
                      pressableClasses
                    )}
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "h-4 w-4 shrink-0 transition-transform",
                        open && "rotate-180"
                      )}
                    />
                    <span className="font-mono text-sm font-semibold">
                      {version.versionId}
                    </span>
                    <span className="min-w-0 truncate text-sm">
                      {version.snapshotTitle}
                    </span>
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {version.changeType === "restore" ? "Restored" : "Published"}{" "}
                    {formatAdminDateTime(version.changedAt)} by{" "}
                    {version.changedBy.name}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoring !== ""}
                    onClick={() => void handleRestore(version)}
                  >
                    <RotateCcw aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                    {restoring === version.versionId
                      ? "Restoring…"
                      : "Restore"}
                  </Button>
                </div>
                {open === "loading" && (
                  <p
                    role="status"
                    className="border-t border-stone px-4 py-3 text-sm text-muted-foreground"
                  >
                    Loading revision…
                  </p>
                )}
                {open && open !== "loading" && (
                  <div className="border-t border-stone px-4 py-4">
                    <KnowledgeArticleBody
                      markdown={open.snapshot.bodyMarkdown}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
