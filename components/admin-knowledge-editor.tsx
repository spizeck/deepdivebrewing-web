"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  MessageSquareQuote,
  Quote,
  Table as TableIcon,
} from "lucide-react";
import { AdminAuthGate } from "@/components/admin-auth-gate";
import { Button } from "@/components/ui/button";
import { cn, pressableClasses } from "@/lib/utils";
import { KnowledgeArticleBody } from "@/components/knowledge-article-body";
import { KnowledgeStatusBadge } from "@/components/admin-knowledge-page";
import {
  createKnowledgeApi,
  KnowledgeApiError,
  type KnowledgeApi,
} from "@/lib/knowledge-client";
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_DOCUMENT_TYPES,
  knowledgeCategoryLabel,
  knowledgeDocumentTypeLabel,
  slugifyKnowledgeTitle,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeCategory,
  type KnowledgeDocumentType,
} from "@/lib/knowledge-common";

const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2";

interface DraftState {
  title: string;
  slug: string;
  summary: string;
  category: KnowledgeCategory;
  documentType: KnowledgeDocumentType;
  tagsCsv: string;
  bodyMarkdown: string;
}

const EMPTY_DRAFT: DraftState = {
  title: "",
  slug: "",
  summary: "",
  category: "brewery-operations",
  documentType: "sop",
  tagsCsv: "",
  bodyMarkdown: "",
};

function draftFromArticle(article: KnowledgeArticleView): DraftState {
  return {
    title: article.title,
    slug: article.slug,
    summary: article.summary,
    category: article.category,
    documentType: article.documentType,
    tagsCsv: article.tags.join(", "),
    bodyMarkdown: article.bodyMarkdown,
  };
}

function toInput(draft: DraftState): KnowledgeArticleInput {
  return {
    title: draft.title,
    slug: draft.slug,
    summary: draft.summary,
    category: draft.category,
    documentType: draft.documentType,
    tags: draft.tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    bodyMarkdown: draft.bodyMarkdown,
  };
}

export function AdminKnowledgeEditorPage({ slug }: { slug?: string }) {
  return (
    <AdminAuthGate
      heading="Knowledge Base Editor"
      description="Sign in with an authorized Google account to create and edit SOPs."
    >
      {(user) => (
        <KnowledgeEditor api={createKnowledgeApi(user)} slug={slug} />
      )}
    </AdminAuthGate>
  );
}

type EditorMode = "write" | "preview";

export function KnowledgeEditor({
  api,
  slug,
}: {
  api: KnowledgeApi;
  slug?: string;
}) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slugTouchedRef = useRef(false);

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [savedArticle, setSavedArticle] = useState<KnowledgeArticleView | null>(
    null
  );
  const [loading, setLoading] = useState(Boolean(slug));
  const [loadError, setLoadError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [mode, setMode] = useState<EditorMode>("write");
  const [busy, setBusy] = useState<"" | "save" | "publish" | "archive">("");
  const [dirty, setDirty] = useState(false);

  const isNew = !slug;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getArticle(slug)
      .then((article) => {
        if (cancelled) return;
        setSavedArticle(article);
        setDraft(draftFromArticle(article));
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) setLoadError("Article not found or unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, slug]);

  // Warn before leaving with unsaved edits — covers tab close and external
  // navigation. In-app links below run the same check through confirmLeave().
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmLeave = useCallback(() => {
    if (!dirty) return true;
    return window.confirm(
      "You have unsaved changes. Leave without saving?"
    );
  }, [dirty]);

  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDirty(true);
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      // Auto-suggest the slug from the title while creating, until the author
      // edits the slug field directly.
      if (key === "title" && isNew && !slugTouchedRef.current) {
        next.slug = slugifyKnowledgeTitle(value as string);
      }
      return next;
    });
  }

  // Wraps the current textarea selection in `before`/`after`, or drops a
  // placeholder line at the cursor. Keeps authored Markdown clean.
  function insertSnippet(before: string, after = "", placeholder = "") {
    const el = textareaRef.current;
    if (!el) {
      update("bodyMarkdown", draft.bodyMarkdown + before + placeholder + after);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = draft.bodyMarkdown.slice(start, end) || placeholder;
    const next =
      draft.bodyMarkdown.slice(0, start) +
      before +
      selected +
      after +
      draft.bodyMarkdown.slice(end);
    update("bodyMarkdown", next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + before.length;
      el.selectionEnd = start + before.length + selected.length;
    });
  }

  function insertAtLineStart(prefix: string) {
    const el = textareaRef.current;
    if (!el) {
      update("bodyMarkdown", draft.bodyMarkdown + `\n${prefix}`);
      return;
    }
    const start = el.selectionStart;
    const lineStart = draft.bodyMarkdown.lastIndexOf("\n", start - 1) + 1;
    const next =
      draft.bodyMarkdown.slice(0, lineStart) +
      prefix +
      draft.bodyMarkdown.slice(lineStart);
    update("bodyMarkdown", next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + prefix.length;
    });
  }

  const toolbar: {
    label: string;
    icon: typeof Bold;
    action: () => void;
  }[] = useMemo(
    () => [
      {
        label: "Heading 2",
        icon: Heading2,
        action: () => insertAtLineStart("## "),
      },
      {
        label: "Heading 3",
        icon: Heading3,
        action: () => insertAtLineStart("### "),
      },
      {
        label: "Bold",
        icon: Bold,
        action: () => insertSnippet("**", "**", "bold text"),
      },
      {
        label: "Italic",
        icon: Italic,
        action: () => insertSnippet("*", "*", "italic text"),
      },
      {
        label: "Link",
        icon: Link2,
        action: () =>
          insertSnippet("[", "](https://example.com)", "link text"),
      },
      {
        label: "Bulleted list",
        icon: List,
        action: () => insertAtLineStart("- "),
      },
      {
        label: "Numbered list",
        icon: ListOrdered,
        action: () => insertAtLineStart("1. "),
      },
      {
        label: "Checklist item",
        icon: ListChecks,
        action: () => insertAtLineStart("- [ ] "),
      },
      {
        label: "Blockquote",
        icon: Quote,
        action: () => insertAtLineStart("> "),
      },
      {
        label: "Table",
        icon: TableIcon,
        action: () =>
          insertSnippet(
            "\n| Column A | Column B |\n| --- | --- |\n| ",
            " |  |\n\n",
            "cell"
          ),
      },
      {
        label: "Code",
        icon: Code,
        action: () => insertSnippet("`", "`", "code"),
      },
      {
        label: "Warning callout",
        icon: MessageSquareQuote,
        action: () =>
          insertSnippet(
            "\n:::warning Safety note\n",
            "\n:::\n",
            "Describe the hazard and the required protection."
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.bodyMarkdown]
  );

  async function saveArticle(): Promise<KnowledgeArticleView | null> {
    const input = toInput(draft);
    try {
      const article = isNew
        ? await api.createArticle(input)
        : await api.updateArticle(slug!, input);
      setSavedArticle(article);
      setDirty(false);
      return article;
    } catch (error) {
      const message =
        error instanceof KnowledgeApiError
          ? error.message
          : "Failed to save article.";
      setStatusMessage(message);
      return null;
    }
  }

  async function handleSave() {
    setBusy("save");
    setStatusMessage("");
    try {
      const article = await saveArticle();
      if (!article) return;
      setStatusMessage(
        article.status === "published"
          ? `Saved and published as v${article.version}.`
          : "Draft saved."
      );
      if (isNew) {
        // Move to the canonical edit URL so refreshes hit the saved doc.
        router.replace(`/admin/knowledge/${article.slug}/edit`);
      }
    } finally {
      setBusy("");
    }
  }

  async function handlePublish() {
    setBusy("publish");
    setStatusMessage("");
    try {
      const saved = dirty || isNew ? await saveArticle() : savedArticle;
      if (!saved) return;
      const article = await api.publishArticle(saved.slug);
      setSavedArticle(article);
      setDirty(false);
      setStatusMessage(`Published as v${article.version}.`);
      if (isNew) {
        router.replace(`/admin/knowledge/${article.slug}/edit`);
      }
    } catch (error) {
      setStatusMessage(
        error instanceof KnowledgeApiError
          ? error.message
          : "Failed to publish."
      );
    } finally {
      setBusy("");
    }
  }

  async function handleArchive() {
    if (!savedArticle) return;
    if (
      !window.confirm(
        `Archive "${savedArticle.title}"? It stays readable under History but leaves the main lists.`
      )
    ) {
      return;
    }
    setBusy("archive");
    setStatusMessage("");
    try {
      const article = await api.archiveArticle(savedArticle.slug);
      setSavedArticle(article);
      setStatusMessage("Archived.");
    } catch (error) {
      setStatusMessage(
        error instanceof KnowledgeApiError
          ? error.message
          : "Failed to archive."
      );
    } finally {
      setBusy("");
    }
  }

  async function handleUpload(file: File | null) {
    if (!file) return;
    const targetSlug = draft.slug;
    if (!targetSlug) {
      setStatusMessage("Set a slug before uploading an image.");
      return;
    }
    setStatusMessage("Uploading attachment…");
    try {
      const kbRef = await api.uploadAttachment(targetSlug, file);
      insertSnippet("![", `](${kbRef})`, file.name);
      setStatusMessage("Attachment uploaded and inserted.");
    } catch (error) {
      console.error(error);
      setStatusMessage("Attachment upload failed.");
    }
  }

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading article…
      </p>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <p role="alert" className="text-sm text-ember">
          {loadError}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/admin/knowledge">Back to Knowledge Base</Link>
        </Button>
      </div>
    );
  }

  const viewHref = savedArticle
    ? `/admin/knowledge/${savedArticle.slug}`
    : "/admin/knowledge";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link
              href="/admin/knowledge"
              onClick={(e) => {
                if (!confirmLeave()) e.preventDefault();
              }}
              className="text-ocean hover:underline"
            >
              ← Knowledge Base
            </Link>
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {isNew ? "New article" : `Edit: ${savedArticle?.title ?? slug}`}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {savedArticle && (
            <KnowledgeStatusBadge status={savedArticle.status} />
          )}
          {savedArticle && (
            <Button
              asChild
              variant="outline"
              size="sm"
              onClick={(e: React.MouseEvent) => {
                if (!confirmLeave()) e.preventDefault();
              }}
            >
              <Link href={viewHref}>View</Link>
            </Button>
          )}
          {savedArticle && savedArticle.status !== "archived" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== ""}
              onClick={handleArchive}
            >
              {busy === "archive" ? "Archiving…" : "Archive"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== ""}
            onClick={handleSave}
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </Button>
          <Button size="sm" disabled={busy !== ""} onClick={handlePublish}>
            {busy === "publish"
              ? "Publishing…"
              : savedArticle?.status === "published"
                ? "Save & publish"
                : "Publish"}
          </Button>
        </div>
      </div>

      {statusMessage && (
        <p role="status" className="text-sm text-ocean">
          {statusMessage}
        </p>
      )}
      {dirty && (
        <p role="status" className="text-xs text-muted-foreground">
          Unsaved changes
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">
            Title
            <span aria-hidden="true" className="text-ember"> *</span>
          </span>
          <input
            required
            className={fieldClass}
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">
            Slug
            <span aria-hidden="true" className="text-ember"> *</span>
          </span>
          <input
            required
            className={fieldClass}
            value={draft.slug}
            disabled={!isNew}
            onChange={(e) => {
              slugTouchedRef.current = true;
              update(
                "slug",
                e.target.value.trim().toLowerCase().replace(/\s+/g, "-")
              );
            }}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Category</span>
          <select
            className={fieldClass}
            value={draft.category}
            onChange={(e) =>
              update("category", e.target.value as KnowledgeCategory)
            }
          >
            {KNOWLEDGE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {knowledgeCategoryLabel(category)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Document type</span>
          <select
            className={fieldClass}
            value={draft.documentType}
            onChange={(e) =>
              update("documentType", e.target.value as KnowledgeDocumentType)
            }
          >
            {KNOWLEDGE_DOCUMENT_TYPES.map((docType) => (
              <option key={docType} value={docType}>
                {knowledgeDocumentTypeLabel(docType)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Summary</span>
        <input
          className={fieldClass}
          value={draft.summary}
          onChange={(e) => update("summary", e.target.value)}
          placeholder="One-line description shown in lists and under the title"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">
          Tags (comma-separated)
        </span>
        <input
          className={fieldClass}
          value={draft.tagsCsv}
          onChange={(e) => update("tagsCsv", e.target.value)}
          placeholder="e.g. cip, fermenter, chemicals"
        />
      </label>

      <div className="rounded-lg border border-stone bg-paper">
        <div className="flex flex-wrap items-center gap-1 border-b border-stone px-3 py-2">
          <div
            role="tablist"
            aria-label="Editor mode"
            className="flex items-center gap-1"
          >
            {(["write", "preview"] as const).map((next) => (
              <button
                key={next}
                type="button"
                role="tab"
                aria-selected={mode === next}
                onClick={() => setMode(next)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium",
                  mode === next ? "bg-stone/60 text-ink" : "text-muted-foreground hover:bg-stone/30",
                  pressableClasses
                )}
              >
                {next === "write" ? "Write" : "Preview"}
              </button>
            ))}
          </div>
          <span className="mx-1 hidden h-5 w-px bg-stone sm:block" aria-hidden="true" />
          {mode === "write" && (
            <div
              role="toolbar"
              aria-label="Markdown formatting"
              className="flex flex-wrap items-center gap-0.5"
            >
              {toolbar.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={item.action}
                  className={cn(
                    "inline-flex h-9 w-9 items-center justify-center rounded-md text-ink/70 hover:bg-stone/40",
                    pressableClasses
                  )}
                >
                  <item.icon aria-hidden="true" className="h-4 w-4" />
                </button>
              ))}
              <button
                type="button"
                title="Upload image"
                aria-label="Upload image"
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "inline-flex h-9 w-9 items-center justify-center rounded-md text-ink/70 hover:bg-stone/40",
                  pressableClasses
                )}
              >
                <ImagePlus aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            className="hidden"
            aria-label="Upload image or PDF attachment"
            onChange={(e) => {
              void handleUpload(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </div>

        {mode === "write" ? (
          <>
            <label htmlFor="kb-body" className="sr-only">
              Article Markdown
            </label>
            <textarea
              id="kb-body"
              ref={textareaRef}
              className="min-h-[60vh] w-full resize-y rounded-b-lg bg-paper p-4 font-mono text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ocean/50"
              value={draft.bodyMarkdown}
              onChange={(e) => update("bodyMarkdown", e.target.value)}
              placeholder={
                "## Purpose\n\nWhat this procedure covers.\n\n:::warning Safety\nRequired PPE before starting.\n:::\n\n## Steps\n\n1. First step\n2. Second step\n"
              }
              spellCheck
            />
          </>
        ) : (
          <div className="p-4">
            <KnowledgeArticleBody markdown={draft.bodyMarkdown} />
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Callouts: <code>:::note</code>, <code>:::info</code>, <code>:::tip</code>,{" "}
        <code>:::warning</code>, <code>:::danger</code> — close with{" "}
        <code>:::</code>. Attachments use <code>kb:slug/filename</code> links.
      </p>
    </div>
  );
}
