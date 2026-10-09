import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Regression coverage for the attachment upload contract (#205): uploads go
// to knowledge/<slug>/<timestamp>-<sanitized-name> and return a matching
// `kb:` reference. firebase/storage and the app accessor are module-mocked so
// the test exercises only the path/reference logic.

const uploads: { path: string; size: number }[] = [];

mock.module("@/lib/firebase", {
  namedExports: {
    getFirebaseStorage: () => ({}),
  },
});

mock.module("firebase/storage", {
  namedExports: {
    ref: (_storage: unknown, path: string) => ({ path }),
    uploadBytes: async (r: { path: string }, file: File) => {
      uploads.push({ path: r.path, size: file.size });
    },
  },
});

async function api() {
  const { createKnowledgeApi } = await import("@/lib/knowledge-client");
  return createKnowledgeApi({ getIdToken: async () => "token" });
}

describe("uploadAttachment", () => {
  it("stores under knowledge/<slug>/ and returns the kb: reference", async () => {
    const kbRef = await (await api()).uploadAttachment(
      "keg-washer",
      new File(["bytes"], "My Photo.PNG")
    );
    assert.match(kbRef, /^kb:keg-washer\/\d+-my-photo\.png$/);
    assert.strictEqual(uploads.length, 1);
    assert.match(
      uploads[0].path,
      /^knowledge\/keg-washer\/\d+-my-photo\.png$/
    );
  });

  it("sanitizes unsafe names and keeps a stable stem", async () => {
    uploads.length = 0;
    const client = await api();
    const kbRef = await client.uploadAttachment(
      "keg-washer",
      new File(["x"], "schéma ??final.png")
    );
    assert.match(kbRef, /^kb:keg-washer\/\d+-[a-z0-9.-]+$/);
    assert.ok(!kbRef.includes(" "));
    assert.ok(!kbRef.includes("?"));
    // A name that sanitizes to a bare extension gets a stem so the object
    // name is never just ".png".
    const bare = await client.uploadAttachment(
      "keg-washer",
      new File(["x"], ".png")
    );
    assert.match(bare, /^kb:keg-washer\/\d+-file\.png$/);
  });
});
