import "server-only";
import type { AdminActor } from "@/lib/admin-auth";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getFirebaseAdminBucket } from "@/lib/firebase-admin-storage";
import {
  isKnowledgeAttachmentName,
  isKnowledgeSlug,
  KNOWLEDGE_COLLECTION,
  KNOWLEDGE_STORAGE_PREFIX,
  KNOWLEDGE_VERSIONS_SUBCOLLECTION,
  knowledgeMarkdownReferencesAttachment,
  parseKnowledgeInput,
  searchKnowledgeArticles,
  serializeKnowledgeArticle,
  serializeKnowledgeVersion,
  type KnowledgeActorRef,
  type KnowledgeArticleDoc,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeArticleSummary,
  type KnowledgeAttachmentView,
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

/**
 * Attachment objects for one article (#205). Objects live under
 * `knowledge/<slug>/`; uploads use the client SDK while listing and deletion
 * go through the Admin SDK so the reference check below can read the article
 * documents and their version snapshots — `knowledgeArticles` is deny-all
 * to clients.
 *
 * Reference detection scans every body that could still render the file:
 * every article document in the corpus (a `kb:other-slug/file` reference in
 * one article legitimately points at another article's prefix) plus every
 * stored version snapshot across all articles. The scan is corpus-wide
 * because deleting an object that another article's draft or history still
 * references would break that article. Anything still referenced is marked
 * `referenced` and refused by deleteKnowledgeAttachment — removing a
 * Markdown line is only a detach; deleting the object is always an
 * explicit, guarded action.
 *
 * The bounds cap worst-case reads — same tradeoff as the bounded search
 * above; the SOP corpus is tens of documents, not thousands.
 */
const ATTACHMENT_REF_ARTICLE_SCAN_LIMIT = 500;
const ATTACHMENT_REF_VERSION_SCAN_LIMIT = 1000;

async function knowledgeAttachmentReferenceTexts(): Promise<string[]> {
  const texts: string[] = [];
  const db = getFirebaseAdminDb();
  const articlesSnap = await db
    .collection(KNOWLEDGE_COLLECTION)
    .select("bodyMarkdown")
    .limit(ATTACHMENT_REF_ARTICLE_SCAN_LIMIT)
    .get();
  for (const doc of articlesSnap.docs) {
    const body = (doc.data() as { bodyMarkdown?: unknown }).bodyMarkdown;
    if (typeof body === "string") texts.push(body);
  }
  const versionsSnap = await db
    .collectionGroup(KNOWLEDGE_VERSIONS_SUBCOLLECTION)
    .select("snapshot.bodyMarkdown")
    .limit(ATTACHMENT_REF_VERSION_SCAN_LIMIT)
    .get();
  for (const doc of versionsSnap.docs) {
    const body = (doc.data() as { snapshot?: { bodyMarkdown?: unknown } })
      .snapshot?.bodyMarkdown;
    if (typeof body === "string") texts.push(body);
  }
  return texts;
}

// The article document is allowed to be absent: uploads can land under a
// slug before the first save, and those orphans must stay listable so they
// can be reattached or deleted.
export async function listKnowledgeAttachments(
  slug: string
): Promise<KnowledgeAttachmentView[]> {
  if (!isKnowledgeSlug(slug)) {
    throw new KnowledgeError("Invalid article slug.", 400);
  }
  const prefix = `${KNOWLEDGE_STORAGE_PREFIX}/${slug}/`;
  const [files] = await getFirebaseAdminBucket().getFiles({ prefix });
  const texts = await knowledgeAttachmentReferenceTexts();

  const attachments: KnowledgeAttachmentView[] = [];
  for (const file of files) {
    const name = file.name.slice(prefix.length);
    // Only direct children of the article prefix are article attachments.
    if (!name || name.includes("/")) continue;
    const meta = file.metadata ?? {};
    const size = Number(meta.size);
    const updated =
      typeof meta.timeCreated === "string"
        ? meta.timeCreated
        : typeof meta.updated === "string"
          ? meta.updated
          : null;
    attachments.push({
      name,
      size: Number.isFinite(size) ? size : 0,
      contentType:
        typeof meta.contentType === "string" ? meta.contentType : "",
      updatedAt: updated,
      referenced: texts.some((text) =>
        knowledgeMarkdownReferencesAttachment(text, slug, name)
      ),
    });
  }
  return attachments.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteKnowledgeAttachment(
  slug: string,
  name: string
): Promise<void> {
  if (!isKnowledgeSlug(slug)) {
    throw new KnowledgeError("Invalid article slug.", 400);
  }
  if (!isKnowledgeAttachmentName(name)) {
    throw new KnowledgeError("Invalid attachment name.", 400);
  }

  const texts = await knowledgeAttachmentReferenceTexts();
  if (
    texts.some((text) =>
      knowledgeMarkdownReferencesAttachment(text, slug, name)
    )
  ) {
    throw new KnowledgeError(
      `"${name}" is still referenced by the article or a saved version. Remove the reference everywhere before deleting.`,
      409
    );
  }

  // Check-then-delete cannot be atomic — a concurrent save can add a
  // reference while the object is being removed, leaving a stale `kb:` link
  // (which renders the "unavailable" fallback rather than crashing). The
  // window is milliseconds on an internal admin tool; serializing saves and
  // deletes would need a corpus-wide lock that Firestore/Storage do not
  // offer.

  const file = getFirebaseAdminBucket().file(
    `${KNOWLEDGE_STORAGE_PREFIX}/${slug}/${name}`
  );
  const [exists] = await file.exists();
  if (!exists) throw new KnowledgeError("Attachment not found.", 404);
  await file.delete();
}
