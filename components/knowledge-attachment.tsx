"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getBlob, ref } from "firebase/storage";
import { FileText } from "lucide-react";
import { getFirebaseStorage } from "@/lib/firebase";
import { KNOWLEDGE_STORAGE_PREFIX } from "@/lib/knowledge-common";

/**
 * Resolves `kb:` attachment references to Firebase Storage objects under the
 * knowledge/ prefix. Objects are fetched through the authenticated client SDK
 * (getBlob), which carries the reader's Firebase Auth token — storage.rules
 * restricts the prefix to active admins, and no public download token is ever
 * minted. The result is a short-lived blob: object URL; it is revoked on
 * unmount.
 */
export function useAttachmentUrl(path: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    (async () => {
      try {
        const blob = await getBlob(
          ref(getFirebaseStorage(), `${KNOWLEDGE_STORAGE_PREFIX}/${path}`)
        );
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setFailed(false);
        setUrl(objectUrl);
      } catch (error) {
        console.error("Failed to load knowledge attachment:", error);
        if (!cancelled) {
          setUrl(null);
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return { url, failed };
}

export function KnowledgeStorageImage({
  path,
  alt,
}: {
  path: string;
  alt: string;
}) {
  const { url, failed } = useAttachmentUrl(path);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={alt || "Image unavailable"}
        className="my-2 inline-block rounded-md border border-stone bg-stone/30 px-3 py-2 text-sm text-muted-foreground"
      >
        Image unavailable ({alt || path})
      </span>
    );
  }
  if (!url) {
    return (
      <span className="my-2 inline-block rounded-md border border-stone bg-stone/20 px-3 py-2 text-sm text-muted-foreground">
        Loading image…
      </span>
    );
  }
  // blob: object URLs cannot go through next/image.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} className="kb-image" />
  );
}

export function KnowledgeStorageLink({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const { url, failed } = useAttachmentUrl(path);
  const filename = path.split("/").pop() ?? path;

  if (failed) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <FileText aria-hidden="true" className="inline h-4 w-4" />
        {children ?? filename} (unavailable)
      </span>
    );
  }
  if (!url) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <FileText aria-hidden="true" className="inline h-4 w-4" />
        {children ?? filename}
      </span>
    );
  }
  return (
    <a href={url} download={filename}>
      <FileText aria-hidden="true" className="mr-1 inline h-4 w-4" />
      {children ?? filename}
    </a>
  );
}
