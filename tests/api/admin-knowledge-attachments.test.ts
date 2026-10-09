import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";
import type { KnowledgeAttachmentView } from "@/lib/knowledge-common";

// Route-level coverage for the attachments endpoints (#205): admin-only auth,
// slug/name validation (attachment paths can never escape the article's own
// knowledge/<slug>/ prefix), and the referenced-elsewhere delete block.
// Server-only dependencies are module-mocked so the handlers exercise only
// their own decisions against a real NextRequest.

mock.module("server-only", { namedExports: {} });

let adminError: { message: string; status: number } | null = null;

mock.module("@/lib/admin-auth", {
  namedExports: {
    requireAdminActor: async () => {
      if (adminError) {
        throw Object.assign(new Error(adminError.message), {
          clientSafe: true,
          status: adminError.status,
        });
      }
      return {
        token: { uid: "admin-1", email: "admin@example.test" },
        claims: { admin: true, role: "admin" },
        record: { uid: "admin-1", email: "admin@example.test" },
      };
    },
  },
});

const listCalls: string[] = [];
let listResult: KnowledgeAttachmentView[] = [];
let listError: { message: string; status: number } | null = null;

const deleteCalls: { slug: string; name: string }[] = [];
let deleteError: { message: string; status: number } | null = null;

mock.module("@/lib/knowledge-admin", {
  namedExports: {
    listKnowledgeAttachments: async (slug: string) => {
      listCalls.push(slug);
      if (listError) {
        throw Object.assign(new Error(listError.message), {
          clientSafe: true,
          status: listError.status,
        });
      }
      return listResult;
    },
    deleteKnowledgeAttachment: async (slug: string, name: string) => {
      deleteCalls.push({ slug, name });
      if (deleteError) {
        throw Object.assign(new Error(deleteError.message), {
          clientSafe: true,
          status: deleteError.status,
        });
      }
    },
  },
});

function req(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): NextRequest {
  return new NextRequest(`https://deepdivebrewing.com${url}`, init);
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const AUTH = { authorization: "Bearer id-token" };

beforeEach(() => {
  adminError = null;
  listCalls.length = 0;
  listResult = [];
  listError = null;
  deleteCalls.length = 0;
  deleteError = null;
});

describe("GET /api/admin/knowledge/[id]/attachments", () => {
  it("rejects unauthenticated calls", async () => {
    const { GET } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    const res = await GET(
      req("/api/admin/knowledge/keg-washer/attachments"),
      params("keg-washer")
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(listCalls.length, 0);
  });

  it("enforces the admin actor check", async () => {
    const { GET } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    adminError = {
      message: "This action requires administrator access.",
      status: 403,
    };
    const res = await GET(
      req("/api/admin/knowledge/keg-washer/attachments", {
        headers: AUTH,
      }),
      params("keg-washer")
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(listCalls.length, 0);
  });

  it("rejects invalid article slugs", async () => {
    const { GET } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    for (const id of ["Bad Slug", "UPPER", "..", "a--b", ""]) {
      const res = await GET(
        req(`/api/admin/knowledge/${encodeURIComponent(id)}/attachments`, {
          headers: AUTH,
        }),
        params(id)
      );
      assert.strictEqual(res.status, 400, `slug: ${id}`);
    }
    assert.strictEqual(listCalls.length, 0);
  });

  it("returns the attachment list for an admin", async () => {
    const { GET } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    listResult = [
      {
        name: "1700-photo.jpg",
        size: 1234,
        contentType: "image/jpeg",
        updatedAt: "2026-10-01T00:00:00.000Z",
        referenced: true,
      },
    ];
    const res = await GET(
      req("/api/admin/knowledge/keg-washer/attachments", {
        headers: AUTH,
      }),
      params("keg-washer")
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.attachments[0].name, "1700-photo.jpg");
    assert.strictEqual(body.attachments[0].referenced, true);
    assert.deepStrictEqual(listCalls, ["keg-washer"]);
  });
});

describe("DELETE /api/admin/knowledge/[id]/attachments", () => {
  const url = "/api/admin/knowledge/keg-washer/attachments";

  function deleteReq(name: unknown): NextRequest {
    return req(url, {
      method: "DELETE",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  it("rejects unauthenticated calls", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    const res = await DELETE(
      req(url, { method: "DELETE" }),
      params("keg-washer")
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(deleteCalls.length, 0);
  });

  it("enforces the admin actor check", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    adminError = {
      message: "This action requires administrator access.",
      status: 403,
    };
    const res = await DELETE(deleteReq("a.png"), params("keg-washer"));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(deleteCalls.length, 0);
  });

  it("rejects invalid JSON and missing names", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    const badJson = await DELETE(
      req(url, {
        method: "DELETE",
        headers: { ...AUTH, "content-type": "application/json" },
        body: "{",
      }),
      params("keg-washer")
    );
    assert.strictEqual(badJson.status, 400);
    const missing = await DELETE(deleteReq(undefined), params("keg-washer"));
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(deleteCalls.length, 0);
  });

  it("rejects names that could escape the article prefix", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    for (const name of ["a/b.png", "../other-sop/x.png", "..", ".", "", "a\\b"]) {
      const res = await DELETE(deleteReq(name), params("keg-washer"));
      assert.strictEqual(res.status, 400, `name: ${name}`);
    }
    assert.strictEqual(deleteCalls.length, 0);
  });

  it("rejects an invalid article slug before touching storage", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    const res = await DELETE(deleteReq("a.png"), params("Bad Slug"));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(deleteCalls.length, 0);
  });

  it("surfaces the server's referenced-elsewhere block", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    deleteError = {
      message:
        '"a.png" is still referenced by the article or a saved version.',
      status: 409,
    };
    const res = await DELETE(deleteReq("a.png"), params("keg-washer"));
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /still referenced/);
  });

  it("surfaces a missing attachment as 404", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    deleteError = { message: "Attachment not found.", status: 404 };
    const res = await DELETE(deleteReq("gone.png"), params("keg-washer"));
    assert.strictEqual(res.status, 404);
  });

  it("deletes an unreferenced attachment for an admin", async () => {
    const { DELETE } = await import(
      "@/app/api/admin/knowledge/[id]/attachments/route"
    );
    const res = await DELETE(deleteReq("a.png"), params("keg-washer"));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(deleteCalls, [
      { slug: "keg-washer", name: "a.png" },
    ]);
  });
});
