import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Service-level coverage for the attachment guard itself (#205): the real
// listKnowledgeAttachments/deleteKnowledgeAttachment run against fake Admin
// SDK surfaces, so the corpus-wide reference check and the "never delete a
// referenced object" rule are exercised — not just the route's status mapping.

mock.module("server-only", { namedExports: {} });

// Bodies the fake Firestore returns for the corpus-wide reference scan.
let articleBodies: string[] = [];
let versionBodies: string[] = [];

mock.module("@/lib/firebase-admin-db", {
  namedExports: {
    getFirebaseAdminDb: () => ({
      collection: () => ({
        select: () => ({
          limit: () => ({
            get: async () => ({
              docs: articleBodies.map((bodyMarkdown) => ({
                data: () => ({ bodyMarkdown }),
              })),
              size: articleBodies.length,
            }),
          }),
        }),
      }),
      collectionGroup: () => ({
        select: () => ({
          limit: () => ({
            get: async () => ({
              docs: versionBodies.map((bodyMarkdown) => ({
                data: () => ({ snapshot: { bodyMarkdown } }),
              })),
              size: versionBodies.length,
            }),
          }),
        }),
      }),
    }),
  },
});

// Fake bucket: getFiles serves the stored objects, file() records deletes.
interface FakeObject {
  name: string;
  size?: string;
  contentType?: string;
  timeCreated?: string;
}

let objects: FakeObject[] = [];
const deletedPaths: string[] = [];
let existsResult = true;

mock.module("@/lib/firebase-admin-storage", {
  namedExports: {
    getFirebaseAdminBucket: () => ({
      getFiles: async () => [
        objects.map((o) => ({
          name: o.name,
          metadata: {
            size: o.size,
            contentType: o.contentType,
            timeCreated: o.timeCreated,
          },
        })),
      ],
      file: (path: string) => ({
        exists: async () => [existsResult],
        delete: async () => {
          deletedPaths.push(path);
        },
      }),
    }),
  },
});

beforeEach(() => {
  articleBodies = [];
  versionBodies = [];
  objects = [];
  deletedPaths.length = 0;
  existsResult = true;
});

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
  throw new Error("Expected the call to throw.");
}

describe("listKnowledgeAttachments", () => {
  it("lists direct children with metadata and skips nested objects", async () => {
    const { listKnowledgeAttachments } = await import(
      "@/lib/knowledge-admin"
    );
    objects = [
      {
        name: "knowledge/keg-washer/a.png",
        size: "100",
        contentType: "image/png",
        timeCreated: "2026-10-01T00:00:00.000Z",
      },
      { name: "knowledge/keg-washer/nested/b.png" },
      { name: "knowledge/other/c.png" },
    ];
    const list = await listKnowledgeAttachments("keg-washer");
    assert.deepStrictEqual(
      list.map((a) => a.name),
      ["a.png"]
    );
    assert.strictEqual(list[0].size, 100);
    assert.strictEqual(list[0].contentType, "image/png");
    assert.strictEqual(list[0].referenced, false);
  });

  it("flags files referenced by a different article's body", async () => {
    const { listKnowledgeAttachments } = await import(
      "@/lib/knowledge-admin"
    );
    objects = [{ name: "knowledge/keg-washer/a.png" }];
    // Article "other-sop" references keg-washer's object — the check must
    // not be scoped to the listing article.
    articleBodies = ["See ![a.png](kb:keg-washer/a.png) for detail."];
    const list = await listKnowledgeAttachments("keg-washer");
    assert.strictEqual(list[0].referenced, true);
  });

  it("flags files referenced by any version snapshot", async () => {
    const { listKnowledgeAttachments } = await import(
      "@/lib/knowledge-admin"
    );
    objects = [{ name: "knowledge/keg-washer/a.pdf" }];
    versionBodies = ["[a.pdf](kb:keg-washer/a.pdf)"];
    const list = await listKnowledgeAttachments("keg-washer");
    assert.strictEqual(list[0].referenced, true);
  });

  it("rejects an invalid slug", async () => {
    const { listKnowledgeAttachments } = await import(
      "@/lib/knowledge-admin"
    );
    assert.strictEqual(
      await statusOf(() => listKnowledgeAttachments("Bad Slug")),
      400
    );
  });
});

describe("deleteKnowledgeAttachment", () => {
  it("deletes an unreferenced object at its exact article-scoped path", async () => {
    const { deleteKnowledgeAttachment } = await import(
      "@/lib/knowledge-admin"
    );
    await deleteKnowledgeAttachment("keg-washer", "a.png");
    assert.deepStrictEqual(deletedPaths, ["knowledge/keg-washer/a.png"]);
  });

  it("blocks when any article body references the object", async () => {
    const { deleteKnowledgeAttachment } = await import(
      "@/lib/knowledge-admin"
    );
    articleBodies = [
      "Body of another article linking ![a.png](kb:keg-washer/a.png).",
    ];
    const status = await statusOf(() =>
      deleteKnowledgeAttachment("keg-washer", "a.png")
    );
    assert.strictEqual(status, 409);
    assert.deepStrictEqual(deletedPaths, []);
  });

  it("blocks when a version snapshot references the object", async () => {
    const { deleteKnowledgeAttachment } = await import(
      "@/lib/knowledge-admin"
    );
    versionBodies = ["Old draft with ![a.png](kb:keg-washer/a.png)."];
    const status = await statusOf(() =>
      deleteKnowledgeAttachment("keg-washer", "a.png")
    );
    assert.strictEqual(status, 409);
    assert.deepStrictEqual(deletedPaths, []);
  });

  it("fails closed when the corpus scan is truncated", async () => {
    const { deleteKnowledgeAttachment, listKnowledgeAttachments } =
      await import("@/lib/knowledge-admin");
    // A full page means the scan cannot prove the file is unreferenced.
    articleBodies = Array.from({ length: 500 }, () => "no refs here");
    objects = [{ name: "knowledge/keg-washer/a.png" }];
    const status = await statusOf(() =>
      deleteKnowledgeAttachment("keg-washer", "a.png")
    );
    assert.strictEqual(status, 409);
    assert.deepStrictEqual(deletedPaths, []);
    const list = await listKnowledgeAttachments("keg-washer");
    assert.strictEqual(list[0].referenced, true);
  });

  it("rejects invalid slugs and names before any storage call", async () => {
    const { deleteKnowledgeAttachment } = await import(
      "@/lib/knowledge-admin"
    );
    assert.strictEqual(
      await statusOf(() => deleteKnowledgeAttachment("Bad Slug", "a.png")),
      400
    );
    assert.strictEqual(
      await statusOf(() =>
        deleteKnowledgeAttachment("keg-washer", "../other/x.png")
      ),
      400
    );
    assert.deepStrictEqual(deletedPaths, []);
  });

  it("returns 404 when the object does not exist", async () => {
    const { deleteKnowledgeAttachment } = await import(
      "@/lib/knowledge-admin"
    );
    existsResult = false;
    assert.strictEqual(
      await statusOf(() => deleteKnowledgeAttachment("keg-washer", "a.png")),
      404
    );
    assert.deepStrictEqual(deletedPaths, []);
  });
});
