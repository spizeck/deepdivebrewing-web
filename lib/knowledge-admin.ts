import "server-only";
import type { AdminActor } from "@/lib/admin-auth";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import {
  KNOWLEDGE_COLLECTION,
  KNOWLEDGE_VERSIONS_SUBCOLLECTION,
  parseKnowledgeInput,
  searchKnowledgeArticles,
  serializeKnowledgeArticle,
  serializeKnowledgeVersion,
  type KnowledgeActorRef,
  type KnowledgeArticleDoc,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeArticleSummary,
  type KnowledgeSearchHit,
  type KnowledgeVersionView,
  toKnowledgeSummary,
} from "@/lib/knowledge-common";

/**
 * Server-side Knowledge Base data layer (#201). All access goes through the
 * Admin SDK behind requireAdminActor — `knowledgeArticles` is deny-all to
 * clients in firestore.rules, so these functions are the only read/write
 * surface.
 */

export class KnowledgeError extends Error {
  public readonly clientSafe = true;
  constructor(
    message: string,
    public status: number = 400
  ) {
    super(message);
  }
}

export class KnowledgeNotFoundError extends KnowledgeError {
  constructor(slug: string) {
    super(`Article "${slug}" was not found.`, 404);
  }
}

export function knowledgeActorOf(actor: AdminActor): KnowledgeActorRef {
  return {
    uid: actor.token.uid,
    name:
      actor.record.displayName?.trim() ||
      actor.token.name?.trim() ||
      actor.token.email?.trim() ||
      actor.record.email,
  };
}

function collection() {
  return getFirebaseAdminDb().collection(KNOWLEDGE_COLLECTION);
}

function snapshotOf(input: KnowledgeArticleInput): KnowledgeArticleInput {
  return {
    title: input.title,
    slug: input.slug,
    summary: input.summary,
    category: input.category,
    documentType: input.documentType,
    tags: [...input.tags],
    bodyMarkdown: input.bodyMarkdown,
  };
}

function versionId(version: number): string {
  return `v${String(version).padStart(3, "0")}`;
}

function editableFields(
  input: KnowledgeArticleInput,
  actor: KnowledgeActorRef,
  now: number
) {
  return {
    ...snapshotOf(input),
    updatedAt: now,
    updatedBy: actor,
  };
}

export async function listKnowledgeArticles(): Promise<
  KnowledgeArticleView[]
> {
  const snap = await collection().get();
  const articles = snap.docs.map((d) => serializeKnowledgeArticle(d.data()));
  return articles.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

export async function listKnowledgeSummaries(): Promise<
  KnowledgeArticleSummary[]
> {
  return (await listKnowledgeArticles()).map(toKnowledgeSummary);
}

// Bounded search: the corpus is a single collection of internal SOPs —
// expected order of magnitude is tens of documents, so an in-memory weighted
// scan (lib/knowledge-common) is simpler and more reliable than a query
// index. The bound caps worst-case reads.
const SEARCH_SCAN_LIMIT = 500;

export async function searchKnowledge(
  queryText: string
): Promise<KnowledgeSearchHit[]> {
  const snap = await collection().limit(SEARCH_SCAN_LIMIT).get();
  const articles = snap.docs.map((d) => serializeKnowledgeArticle(d.data()));
  return searchKnowledgeArticles(articles, queryText);
}

export async function getKnowledgeArticle(
  slug: string
): Promise<KnowledgeArticleView> {
  const snap = await collection().doc(slug).get();
  if (!snap.exists) throw new KnowledgeNotFoundError(slug);
  return serializeKnowledgeArticle(snap.data() ?? {});
}

export async function createKnowledgeArticle(
  input: KnowledgeArticleInput,
  actor: KnowledgeActorRef
): Promise<KnowledgeArticleView> {
  const ref = collection().doc(input.slug);
  const now = Date.now();

  try {
    await ref.create({
      ...input,
      status: "draft",
      version: 0,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
      publishedAt: null,
      publishedBy: null,
      lastReviewedAt: null,
      ownerRole: "",
    } satisfies KnowledgeArticleDoc);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 6 // ALREADY_EXISTS
    ) {
      throw new KnowledgeError(
        `An article with slug "${input.slug}" already exists.`,
        409
      );
    }
    throw error;
  }

  return getKnowledgeArticle(input.slug);
}

// Persists edited fields. When the article is already published the save is
// also a republish: a new version snapshot is written so the "published
// content is always versioned" invariant holds and previous published
// revisions are never lost.
export async function updateKnowledgeArticle(
  slug: string,
  input: KnowledgeArticleInput,
  actor: KnowledgeActorRef
): Promise<KnowledgeArticleView> {
  if (input.slug !== slug) {
    throw new KnowledgeError("Slug cannot be changed after creation.", 400);
  }
  const ref = collection().doc(slug);
  const now = Date.now();

  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new KnowledgeNotFoundError(slug);
    const current = snap.data() as KnowledgeArticleDoc;

    if (current.status === "published") {
      const nextVersion = (current.version ?? 0) + 1;
      tx.set(
        ref.collection(KNOWLEDGE_VERSIONS_SUBCOLLECTION).doc(versionId(nextVersion)),
        {
          version: nextVersion,
          snapshot: snapshotOf(input),
          changedAt: now,
          changedBy: actor,
          changeType: "publish",
        }
      );
      tx.update(ref, {
        ...editableFields(input, actor, now),
        version: nextVersion,
        publishedAt: now,
        publishedBy: actor,
      });
    } else {
      tx.update(ref, editableFields(input, actor, now));
    }
  });

  return getKnowledgeArticle(slug);
}

// Promotes a draft/archived article (or republishes an unchanged published
// one is a no-op version bump only when content exists — here we always
// record a revision, keeping a clean audit trail of publishes).
export async function publishKnowledgeArticle(
  slug: string,
  actor: KnowledgeActorRef
): Promise<KnowledgeArticleView> {
  const ref = collection().doc(slug);
  const now = Date.now();

  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new KnowledgeNotFoundError(slug);
    const current = snap.data() as KnowledgeArticleDoc;

    const nextVersion = (current.version ?? 0) + 1;
    const snapshot = snapshotOf(current);
    tx.set(
      ref.collection(KNOWLEDGE_VERSIONS_SUBCOLLECTION).doc(versionId(nextVersion)),
      {
        version: nextVersion,
        snapshot,
        changedAt: now,
        changedBy: actor,
        changeType: "publish",
      }
    );
    tx.update(ref, {
      status: "published",
      version: nextVersion,
      publishedAt: now,
      publishedBy: actor,
      updatedAt: now,
      updatedBy: actor,
    });
  });

  return getKnowledgeArticle(slug);
}

export async function archiveKnowledgeArticle(
  slug: string,
  actor: KnowledgeActorRef
): Promise<KnowledgeArticleView> {
  const ref = collection().doc(slug);
  const snap = await ref.get();
  if (!snap.exists) throw new KnowledgeNotFoundError(slug);
  await ref.update({
    status: "archived",
    updatedAt: Date.now(),
    updatedBy: actor,
  });
  return getKnowledgeArticle(slug);
}

export async function listKnowledgeVersions(
  slug: string
): Promise<KnowledgeVersionView[]> {
  const snap = await collection()
    .doc(slug)
    .collection(KNOWLEDGE_VERSIONS_SUBCOLLECTION)
    .get();
  if (!(await collection().doc(slug).get()).exists) {
    throw new KnowledgeNotFoundError(slug);
  }
  return snap.docs
    .map((d) => serializeKnowledgeVersion(d.id, d.data()))
    .sort((a, b) => b.version - a.version);
}

export async function getKnowledgeVersion(
  slug: string,
  versionIdParam: string
): Promise<KnowledgeVersionView> {
  const snap = await collection()
    .doc(slug)
    .collection(KNOWLEDGE_VERSIONS_SUBCOLLECTION)
    .doc(versionIdParam)
    .get();
  if (!snap.exists) {
    throw new KnowledgeNotFoundError(`${slug}#${versionIdParam}`);
  }
  return serializeKnowledgeVersion(snap.id, snap.data() ?? {});
}

// Copies a stored revision's content back onto the article. Published
// articles additionally record a new version (changeType "restore") so the
// republished content is itself preserved; drafts stay unpublished.
export async function restoreKnowledgeVersion(
  slug: string,
  versionIdParam: string,
  actor: KnowledgeActorRef
): Promise<KnowledgeArticleView> {
  const ref = collection().doc(slug);
  const versionRef = ref
    .collection(KNOWLEDGE_VERSIONS_SUBCOLLECTION)
    .doc(versionIdParam);
  const now = Date.now();

  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const [articleSnap, versionSnap] = await Promise.all([
      tx.get(ref),
      tx.get(versionRef),
    ]);
    if (!articleSnap.exists) throw new KnowledgeNotFoundError(slug);
    if (!versionSnap.exists) {
      throw new KnowledgeNotFoundError(`${slug}#${versionIdParam}`);
    }

    const current = articleSnap.data() as KnowledgeArticleDoc;
    const versionData = versionSnap.data() as { snapshot: unknown };
    const parsed = parseKnowledgeInput(versionData.snapshot);
    if (!parsed.ok) {
      throw new KnowledgeError("Stored revision is invalid.", 500);
    }
    const input = { ...parsed.input, slug };

    if (current.status === "published") {
      const nextVersion = (current.version ?? 0) + 1;
      tx.set(
        ref
          .collection(KNOWLEDGE_VERSIONS_SUBCOLLECTION)
          .doc(versionId(nextVersion)),
        {
          version: nextVersion,
          snapshot: snapshotOf(input),
          changedAt: now,
          changedBy: actor,
          changeType: "restore",
        }
      );
      tx.update(ref, {
        ...editableFields(input, actor, now),
        version: nextVersion,
        publishedAt: now,
        publishedBy: actor,
      });
    } else {
      tx.update(ref, editableFields(input, actor, now));
    }
  });

  return getKnowledgeArticle(slug);
}
