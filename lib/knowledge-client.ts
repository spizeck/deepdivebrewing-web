import type {
  KnowledgeArticleInput,
  KnowledgeArticleSummary,
  KnowledgeArticleView,
  KnowledgeSearchHit,
  KnowledgeVersionView,
} from "@/lib/knowledge-common";
import { KNOWLEDGE_STORAGE_PREFIX } from "@/lib/knowledge-common";
import { getFirebaseStorage } from "@/lib/firebase";
import { ref, uploadBytes } from "firebase/storage";

/**
 * Browser-side client for the /api/admin/knowledge* routes (#201). Every
 * request carries the caller's Firebase ID token; authorization is enforced
 * server-side by requireAdminActor. The interface is also implemented by the
 * fixture data source so the real components can render without Firebase.
 */
export interface KnowledgeApiUser {
  getIdToken: () => Promise<string>;
}

export interface KnowledgeVersionListItem extends Omit<
  KnowledgeVersionView,
  "snapshot"
> {
  snapshotTitle: string;
  snapshotSummary: string;
}

export interface KnowledgeApi {
  listArticles: () => Promise<KnowledgeArticleSummary[]>;
  searchArticles: (queryText: string) => Promise<KnowledgeSearchHit[]>;
  getArticle: (slug: string) => Promise<KnowledgeArticleView>;
  createArticle: (
    input: KnowledgeArticleInput
  ) => Promise<KnowledgeArticleView>;
  updateArticle: (
    slug: string,
    input: KnowledgeArticleInput
  ) => Promise<KnowledgeArticleView>;
  publishArticle: (slug: string) => Promise<KnowledgeArticleView>;
  archiveArticle: (slug: string) => Promise<KnowledgeArticleView>;
  listVersions: (slug: string) => Promise<KnowledgeVersionListItem[]>;
  getVersion: (
    slug: string,
    versionId: string
  ) => Promise<KnowledgeVersionView>;
  restoreVersion: (
    slug: string,
    versionId: string
  ) => Promise<KnowledgeArticleView>;
  // Uploads an article attachment to Storage under knowledge/<slug>/ and
  // returns the `kb:` reference to embed in Markdown.
  uploadAttachment: (slug: string, file: File) => Promise<string>;
}

export class KnowledgeApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function request<T>(
  user: KnowledgeApiUser,
  path: string,
  init?: RequestInit
): Promise<T> {
  const idToken = await user.getIdToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  } & T;
  if (!res.ok || data.ok !== true) {
    throw new KnowledgeApiError(
      data.error ?? "Request failed.",
      res.status
    );
  }
  return data;
}

export function createKnowledgeApi(user: KnowledgeApiUser): KnowledgeApi {
  return {
    listArticles: async () => {
      const data = await request<{ articles: KnowledgeArticleSummary[] }>(
        user,
        "/api/admin/knowledge"
      );
      return data.articles;
    },
    searchArticles: async (queryText) => {
      const data = await request<{ results: KnowledgeSearchHit[] }>(
        user,
        `/api/admin/knowledge?q=${encodeURIComponent(queryText)}`
      );
      return data.results;
    },
    getArticle: async (slug) => {
      const data = await request<{ article: KnowledgeArticleView }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}`
      );
      return data.article;
    },
    createArticle: async (input) => {
      const data = await request<{ article: KnowledgeArticleView }>(
        user,
        "/api/admin/knowledge",
        { method: "POST", body: JSON.stringify(input) }
      );
      return data.article;
    },
    updateArticle: async (slug, input) => {
      const data = await request<{ article: KnowledgeArticleView }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}`,
        { method: "PUT", body: JSON.stringify(input) }
      );
      return data.article;
    },
    publishArticle: async (slug) => {
      const data = await request<{ article: KnowledgeArticleView }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}/publish`,
        { method: "POST" }
      );
      return data.article;
    },
    archiveArticle: async (slug) => {
      const data = await request<{ article: KnowledgeArticleView }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}/archive`,
        { method: "POST" }
      );
      return data.article;
    },
    listVersions: async (slug) => {
      const data = await request<{ versions: KnowledgeVersionListItem[] }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}/versions`
      );
      return data.versions;
    },
    getVersion: async (slug, versionId) => {
      const data = await request<{ version: KnowledgeVersionView }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}/versions/${encodeURIComponent(versionId)}`
      );
      return data.version;
    },
    restoreVersion: async (slug, versionId) => {
      const data = await request<{ article: KnowledgeArticleView }>(
        user,
        `/api/admin/knowledge/${encodeURIComponent(slug)}/restore`,
        { method: "POST", body: JSON.stringify({ versionId }) }
      );
      return data.article;
    },
    uploadAttachment: async (slug, file) => {
      let safeName = file.name
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, "-")
        .replace(/^-+|-+$/g, "");
      // A name made only of non-ASCII characters can sanitize to "" or a
      // bare extension like ".jpg" — give it a stable stem.
      if (!safeName || safeName.startsWith(".")) {
        safeName = `file${safeName}`;
      }
      const objectPath = `${KNOWLEDGE_STORAGE_PREFIX}/${slug}/${Date.now()}-${safeName}`;
      await uploadBytes(ref(getFirebaseStorage(), objectPath), file);
      return `kb:${slug}/${objectPath.split("/").pop()}`;
    },
  };
}
