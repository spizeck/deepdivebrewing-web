"use client";

import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, ImageOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatAdminDateTime } from "@/lib/admin-format";
import { hasFirebaseConfig } from "@/lib/firebase";
import { useAttachmentUrl } from "@/components/knowledge-attachment";
import {
  KnowledgeApiError,
  type KnowledgeApi,
} from "@/lib/knowledge-client";
import {
  isKnowledgeImageAttachment,
  knowledgeMarkdownReferencesAttachment,
  type KnowledgeAttachmentView,
} from "@/lib/knowledge-common";

/**
 * Article-scoped attachment picker for the Knowledge Base editor (#205).
 * Lists the Storage objects under knowledge/<slug>/ so uploaded files can be
 * reinserted without re-uploading. Deleting is a separate explicit action:
 * removing a `kb:` line only detaches the file from the draft, and the
 * server additionally refuses to delete objects that the stored article or
 * any saved version still references.
 */

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ThumbPlaceholder({ failed }: { failed: boolean }) {
  const Icon = failed ? ImageOff : ImageIcon;
  return (
    <span
      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-stone bg-stone/20 text-muted-foreground"
      aria-label={failed ? "Thumbnail unavailable" : "Loading thumbnail"}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </span>
  );
}

function AttachmentThumb({ path }: { path: string }) {
  // Fixture/CI builds have no Firebase config — there is no bucket to fetch
  // from, so render the placeholder instead of firing a request that can
  // only fail.
  if (!hasFirebaseConfig()) {
    return <ThumbPlaceholder failed={false} />;
  }
  return <AttachmentThumbInner path={path} />;
}

function AttachmentThumbInner({ path }: { path: string }) {
  const { url, failed } = useAttachmentUrl(path);
  if (!url) {
    return <ThumbPlaceholder failed={failed} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- blob: object URL
    <img
      src={url}
      alt=""
      className="h-12 w-12 shrink-0 rounded-md border border-stone object-cover"
    />
  );
}

function AttachmentRow({
  slug,
  draftMarkdown,
  item,
  onInsert,
  onDelete,
}: {
  slug: string;
  draftMarkdown: string;
  item: KnowledgeAttachmentView;
  onInsert: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{
    tone: "alert" | "status";
    text: string;
  } | null>(null);

  const isImage = isKnowledgeImageAttachment(item.contentType, item.name);
  const inDraft = knowledgeMarkdownReferencesAttachment(
    draftMarkdown,
    slug,
    item.name
  );
  const inUse = item.referenced || inDraft;

  function handleDeleteClick() {
    if (inUse) {
      setMessage({
        tone: "alert",
        text: `"${item.name}" is still referenced ${
          inDraft
            ? "by the draft below"
            : "by the article or a saved version"
        }. Remove the reference before deleting.`,
      });
      return;
    }
    setMessage(null);
    setConfirming(true);
  }

  async function confirmDelete() {
    setDeleting(true);
    setMessage(null);
    try {
      await onDelete();
    } catch (error) {
      setDeleting(false);
      setConfirming(false);
      setMessage({
        tone: "alert",
        text:
          error instanceof KnowledgeApiError
            ? error.message
            : "Delete failed.",
      });
    }
  }

  const updatedAt = formatAdminDateTime(item.updatedAt);
  const meta = [
    isImage ? "Image" : item.contentType || "File",
    formatSize(item.size),
    updatedAt !== "Unknown" ? updatedAt : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="rounded-md border border-stone p-3">
      <div className="flex items-center gap-3">
        {isImage ? (
          <AttachmentThumb path={`${slug}/${item.name}`} />
        ) : (
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-stone bg-stone/20 text-muted-foreground">
            <FileText aria-hidden="true" className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="text-xs text-muted-foreground">{meta}</p>
          {inUse && (
            <p className="mt-0.5 text-xs font-medium text-ember">
              {inDraft
                ? "Referenced in draft"
                : "Referenced in saved content"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onInsert}
          >
            Insert
          </Button>
          {confirming ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={deleting}
                onClick={confirmDelete}
              >
                {deleting ? "Deleting…" : "Confirm delete"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={deleting}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDeleteClick}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <p role="alert" className="mt-2 text-xs text-ember">
          Permanently delete this file from Storage? This cannot be undone.
        </p>
      )}
      {message && (
        <p
          role={message.tone === "alert" ? "alert" : "status"}
          className={cn(
            "mt-2 text-xs",
            message.tone === "alert" ? "text-ember" : "text-muted-foreground"
          )}
        >
          {message.text}
        </p>
      )}
    </li>
  );
}

export function KnowledgeAttachmentsDialog({
  api,
  slug,
  draftMarkdown,
  open,
  onOpenChange,
  onInsert,
}: {
  api: KnowledgeApi;
  slug: string;
  draftMarkdown: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (name: string, isImage: boolean) => void;
}) {
  const [items, setItems] = useState<KnowledgeAttachmentView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState("");

  // Reset on each open so a reopened dialog always refetches (a new upload
  // may have landed while it was closed). Adjusting state during render is
  // the documented alternative to synchronous setState inside the effect.
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setItems(null);
      setLoadFailed(false);
      setNotice("");
    }
  }

  useEffect(() => {
    if (!open || !slug) return;
    let cancelled = false;
    api
      .listAttachments(slug)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((error) => {
        console.error("Failed to list knowledge attachments:", error);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, slug, open]);

  async function handleDelete(item: KnowledgeAttachmentView) {
    await api.deleteAttachment(slug, item.name);
    setItems(
      (prev) => prev?.filter((x) => x.name !== item.name) ?? prev
    );
    setNotice(`Deleted ${item.name}.`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogTitle className="text-lg font-semibold">
          Attachments
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          Files stored for this article under{" "}
          <code className="text-xs">knowledge/{slug}/</code>. Insert reuses a
          file in the draft; deleting removes the file itself.
        </DialogDescription>

        {!slug && (
          <p role="status" className="text-sm text-muted-foreground">
            Set a slug before managing attachments.
          </p>
        )}
        {slug && items === null && !loadFailed && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading attachments…
          </p>
        )}
        {slug && loadFailed && (
          <p role="alert" className="text-sm text-ember">
            Could not load attachments. Close and try again.
          </p>
        )}
        {slug && items !== null && items.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            No attachments yet — uploaded files will appear here.
          </p>
        )}

        {items !== null && items.length > 0 && (
          <ul className="mt-2 space-y-2">
            {items.map((item) => (
              <AttachmentRow
                key={item.name}
                slug={slug}
                draftMarkdown={draftMarkdown}
                item={item}
                onInsert={() =>
                  onInsert(
                    item.name,
                    isKnowledgeImageAttachment(item.contentType, item.name)
                  )
                }
                onDelete={() => handleDelete(item)}
              />
            ))}
          </ul>
        )}

        {notice && (
          <p role="status" className="mt-3 text-sm text-ocean">
            {notice}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
