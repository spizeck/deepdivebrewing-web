/**
 * Knowledge Base shared model (#201) — client-safe, Firebase-free.
 *
 * Everything in this module is usable from both the browser bundles and the
 * Admin SDK server layer: document shapes, validated vocabularies
 * (categories, document types, statuses), slug rules, input validation,
 * serialization, and the bounded in-memory search used by
 * /api/admin/knowledge. Nothing here may import firebase/*.
 */

export const KNOWLEDGE_COLLECTION = "knowledgeArticles";
export const KNOWLEDGE_VERSIONS_SUBCOLLECTION = "versions";

// Validated category list — a full category manager is out of scope for the
// MVP, but a controlled vocabulary keeps the left nav and search filters
// predictable. Values are stored verbatim on documents.
export const KNOWLEDGE_CATEGORIES = [
  "brewery-operations",
  "brewing",
  "cleaning-sanitation",
  "packaging",
  "equipment",
  "tours",
  "sales-distribution",
  "accounting",
  "safety",
  "admin-it",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  "brewery-operations": "Brewery Operations",
  brewing: "Brewing",
  "cleaning-sanitation": "Cleaning & Sanitation",
  packaging: "Packaging",
  equipment: "Equipment",
  tours: "Tours",
  "sales-distribution": "Sales & Distribution",
  accounting: "Accounting",
  safety: "Safety",
  "admin-it": "Admin / IT",
};

export const KNOWLEDGE_DOCUMENT_TYPES = [
  "sop",
  "checklist",
  "reference",
  "policy",
] as const;

export type KnowledgeDocumentType =
  (typeof KNOWLEDGE_DOCUMENT_TYPES)[number];

export const KNOWLEDGE_DOCUMENT_TYPE_LABELS: Record<
  KnowledgeDocumentType,
  string
> = {
  sop: "SOP",
  checklist: "Checklist",
  reference: "Reference",
  policy: "Policy",
};

export const KNOWLEDGE_STATUSES = ["draft", "published", "archived"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_CALLOUT_TYPES = [
  "note",
  "info",
  "tip",
  "warning",
  "danger",
] as const;

export type KnowledgeCalloutType = (typeof KNOWLEDGE_CALLOUT_TYPES)[number];

// Storage prefix for article attachments. storage.rules grants
// active-admin read/write on this root and excludes it from the public-read
// catch-all. Markdown references objects with the `kb:` scheme, e.g.
// ![photo](kb:my-sop/valve.jpg).
export const KNOWLEDGE_STORAGE_PREFIX = "knowledge";

export interface KnowledgeActorRef {
  uid: string;
  name: string;
}

export interface KnowledgeArticleInput {
  title: string;
  slug: string;
  summary: string;
  category: KnowledgeCategory;
  documentType: KnowledgeDocumentType;
  tags: string[];
  bodyMarkdown: string;
}

export interface KnowledgeArticleDoc extends KnowledgeArticleInput {
  status: KnowledgeStatus;
  // Number of the most recent published revision; 0 while never published.
  version: number;
  createdAt: number;
  createdBy: KnowledgeActorRef;
  updatedAt: number;
  updatedBy: KnowledgeActorRef;
  publishedAt: number | null;
  publishedBy: KnowledgeActorRef | null;
  lastReviewedAt: number | null;
  ownerRole: string;
}

/** Serialized view returned by the API — timestamps as ISO strings. */
export interface KnowledgeArticleView extends KnowledgeArticleInput {
  status: KnowledgeStatus;
  version: number;
  createdAt: string;
  createdBy: KnowledgeActorRef;
  updatedAt: string;
  updatedBy: KnowledgeActorRef;
  publishedAt: string | null;
  publishedBy: KnowledgeActorRef | null;
  lastReviewedAt: string | null;
  ownerRole: string;
}

/** List/landing payload — everything except the (potentially large) body. */
export type KnowledgeArticleSummary = Omit<KnowledgeArticleView, "bodyMarkdown">;

export type KnowledgeVersionChangeType = "publish" | "restore";

export interface KnowledgeVersionDoc {
  version: number;
  snapshot: KnowledgeArticleInput;
  changedAt: number;
  changedBy: KnowledgeActorRef;
  changeType: KnowledgeVersionChangeType;
}

export interface KnowledgeVersionView {
  versionId: string;
  version: number;
  snapshot: KnowledgeArticleInput;
  changedAt: string;
  changedBy: KnowledgeActorRef;
  changeType: KnowledgeVersionChangeType;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TITLE_MAX = 200;
const SUMMARY_MAX = 500;
const TAG_MAX = 40;
const TAGS_MAX = 20;
const BODY_MAX = 200_000;

export function slugifyKnowledgeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function isKnowledgeSlug(value: string): boolean {
  return value.length > 0 && value.length <= 80 && SLUG_PATTERN.test(value);
}

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}

export function isKnowledgeDocumentType(
  value: string
): value is KnowledgeDocumentType {
  return (KNOWLEDGE_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function knowledgeCategoryLabel(value: string): string {
  return isKnowledgeCategory(value)
    ? KNOWLEDGE_CATEGORY_LABELS[value]
    : value;
}

export function knowledgeDocumentTypeLabel(value: string): string {
  return isKnowledgeDocumentType(value)
    ? KNOWLEDGE_DOCUMENT_TYPE_LABELS[value]
    : value;
}

export function knowledgeStatusLabel(value: string): string {
  if (value === "draft") return "Draft";
  if (value === "published") return "Published";
  if (value === "archived") return "Archived";
  return value;
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const normalized = tag.trim().toLowerCase().slice(0, TAG_MAX);
    if (normalized) seen.add(normalized);
  }
  return [...seen].slice(0, TAGS_MAX);
}

export type KnowledgeValidation =
  | { ok: true; input: KnowledgeArticleInput }
  | { ok: false; error: string };

// Shared validation for API create/update bodies. The editor enforces the
// same rules client-side; the server re-checks because the API is the trust
// boundary.
export function parseKnowledgeInput(body: unknown): KnowledgeValidation {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid article payload." };
  }
  const raw = body as Record<string, unknown>;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "Title is required." };
  if (title.length > TITLE_MAX) {
    return { ok: false, error: `Title must be ${TITLE_MAX} characters or fewer.` };
  }

  const slug =
    typeof raw.slug === "string"
      ? raw.slug.trim().toLowerCase()
      : "";
  if (!isKnowledgeSlug(slug)) {
    return {
      ok: false,
      error:
        "Slug must be 1–80 characters of lowercase letters, numbers, and hyphens.",
    };
  }

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary.length > SUMMARY_MAX) {
    return {
      ok: false,
      error: `Summary must be ${SUMMARY_MAX} characters or fewer.`,
    };
  }

  if (typeof raw.category !== "string" || !isKnowledgeCategory(raw.category)) {
    return { ok: false, error: "Choose a valid category." };
  }

  if (
    typeof raw.documentType !== "string" ||
    !isKnowledgeDocumentType(raw.documentType)
  ) {
    return { ok: false, error: "Choose a valid document type." };
  }

  const bodyMarkdown =
    typeof raw.bodyMarkdown === "string" ? raw.bodyMarkdown : "";
  if (!bodyMarkdown.trim()) {
    return { ok: false, error: "Body content is required." };
  }
  if (bodyMarkdown.length > BODY_MAX) {
    return { ok: false, error: "Article body is too large." };
  }

  return {
    ok: true,
    input: {
      title,
      slug,
      summary,
      category: raw.category,
      documentType: raw.documentType,
      tags: normalizeTags(raw.tags),
      bodyMarkdown,
    },
  };
}

interface MillisLike {
  toMillis(): number;
}

function isMillisLike(value: unknown): value is MillisLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "toMillis" in value &&
    typeof (value as { toMillis: unknown }).toMillis === "function"
  );
}

// Admin SDK timestamps arrive as Timestamp objects; views use ISO strings so
// client code never sees Firestore types.
export function knowledgeMillisToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (isMillisLike(value)) {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value === "number") return new Date(value).toISOString();
  return null;
}

export function serializeKnowledgeArticle(
  data: Record<string, unknown>
): KnowledgeArticleView {
  const actor = (v: unknown): KnowledgeActorRef => {
    const r = (typeof v === "object" && v !== null ? v : {}) as Record<
      string,
      unknown
    >;
    return {
      uid: typeof r.uid === "string" ? r.uid : "",
      name: typeof r.name === "string" ? r.name : "unknown",
    };
  };
  return {
    title: typeof data.title === "string" ? data.title : "",
    slug: typeof data.slug === "string" ? data.slug : "",
    summary: typeof data.summary === "string" ? data.summary : "",
    category: isKnowledgeCategory(String(data.category))
      ? (data.category as KnowledgeCategory)
      : "brewery-operations",
    documentType: isKnowledgeDocumentType(String(data.documentType))
      ? (data.documentType as KnowledgeDocumentType)
      : "sop",
    tags: normalizeTags(data.tags),
    bodyMarkdown:
      typeof data.bodyMarkdown === "string" ? data.bodyMarkdown : "",
    status:
      data.status === "published" || data.status === "archived"
        ? data.status
        : "draft",
    version: typeof data.version === "number" ? data.version : 0,
    createdAt: knowledgeMillisToIso(data.createdAt) ?? "",
    createdBy: actor(data.createdBy),
    updatedAt: knowledgeMillisToIso(data.updatedAt) ?? "",
    updatedBy: actor(data.updatedBy),
    publishedAt: knowledgeMillisToIso(data.publishedAt),
    publishedBy: data.publishedBy ? actor(data.publishedBy) : null,
    lastReviewedAt: knowledgeMillisToIso(data.lastReviewedAt),
    ownerRole: typeof data.ownerRole === "string" ? data.ownerRole : "",
  };
}

export function toKnowledgeSummary(
  article: KnowledgeArticleView
): KnowledgeArticleSummary {
  const summary = { ...article } as Partial<KnowledgeArticleView>;
  delete summary.bodyMarkdown;
  return summary as KnowledgeArticleSummary;
}

export function serializeKnowledgeVersion(
  versionId: string,
  data: Record<string, unknown>
): KnowledgeVersionView {
  const article = serializeKnowledgeArticle(
    (typeof data.snapshot === "object" && data.snapshot !== null
      ? data.snapshot
      : {}) as Record<string, unknown>
  );
  const changedBy =
    typeof data.changedBy === "object" && data.changedBy !== null
      ? (data.changedBy as Record<string, unknown>)
      : {};
  return {
    versionId,
    version: typeof data.version === "number" ? data.version : 0,
    snapshot: {
      title: article.title,
      slug: article.slug,
      summary: article.summary,
      category: article.category,
      documentType: article.documentType,
      tags: article.tags,
      bodyMarkdown: article.bodyMarkdown,
    },
    changedAt: knowledgeMillisToIso(data.changedAt) ?? "",
    changedBy: {
      uid: typeof changedBy.uid === "string" ? changedBy.uid : "",
      name: typeof changedBy.name === "string" ? changedBy.name : "unknown",
    },
    changeType: data.changeType === "restore" ? "restore" : "publish",
  };
}

export interface KnowledgeSearchHit {
  article: KnowledgeArticleSummary;
  score: number;
  snippet: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function bodySnippet(body: string, needle: string): string {
  const index = body.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return "";
  const start = Math.max(0, index - 60);
  const end = Math.min(body.length, index + needle.length + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  // Collapse markdown noise in the excerpt so results read like prose.
  const text = body
    .slice(start, end)
    .replace(/[#>*`\-[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${prefix}${text}${suffix}`;
}

// Bounded in-memory search over a small corpus. Weighted field scoring keeps
// the ranking explainable; callers bound the candidate set server-side.
export function searchKnowledgeArticles(
  articles: KnowledgeArticleView[],
  rawQuery: string
): KnowledgeSearchHit[] {
  const queryText = rawQuery.trim().toLowerCase();
  if (!queryText) return [];

  const hits: KnowledgeSearchHit[] = [];
  for (const article of articles) {
    const title = article.title.toLowerCase();
    const summary = article.summary.toLowerCase();
    const category = knowledgeCategoryLabel(article.category).toLowerCase();
    const tags = article.tags.join(" ").toLowerCase();
    const body = article.bodyMarkdown;

    const score =
      countOccurrences(title, queryText) * 8 +
      countOccurrences(tags, queryText) * 5 +
      countOccurrences(category, queryText) * 4 +
      countOccurrences(summary, queryText) * 3 +
      countOccurrences(body.toLowerCase(), queryText);

    if (score <= 0) continue;
    hits.push({
      article: toKnowledgeSummary(article),
      score,
      snippet: bodySnippet(body, queryText) || article.summary,
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, 50);
}

/**
 * Browser tab/print document title for an article page. Browsers use
 * document.title as the default filename for Print → Save as PDF, so this
 * names exports after the SOP instead of the generic page metadata.
 */
export function knowledgeDocumentTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return "Article — Knowledge Base | Deep Dive Brewing Co";
  }
  return `${trimmed} | Knowledge Base | Deep Dive Brewing Co`;
}
