import { describe, it } from "node:test";
import assert from "node:assert";
import {
  serializeAdminUser,
  serializeAdminInvitation,
} from "@/lib/admin-serializers";
import type { AdminUserRecord, AdminInvitation } from "@/lib/admin-types";

const timestamp = (date: Date) =>
  ({
    toDate: () => date,
    toMillis: () => date.getTime(),
  } as unknown as { toDate: () => Date });

describe("serializeAdminUser", () => {
  it("converts Firestore Timestamps to ISO strings", () => {
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const updatedAt = new Date("2025-02-01T00:00:00.000Z");
    const lastLoginAt = new Date("2025-03-01T00:00:00.000Z");

    const record: AdminUserRecord = {
      uid: "uid-1",
      email: "a@example.com",
      role: "admin",
      status: "active",
      createdAt: timestamp(createdAt) as unknown as AdminUserRecord["createdAt"],
      createdBy: "uid-creator",
      updatedAt: timestamp(updatedAt) as unknown as AdminUserRecord["updatedAt"],
      updatedBy: "uid-editor",
      lastLoginAt:
        timestamp(lastLoginAt) as unknown as AdminUserRecord["lastLoginAt"],
    };

    const view = serializeAdminUser(record);
    assert.strictEqual(view.createdAt, createdAt.toISOString());
    assert.strictEqual(view.updatedAt, updatedAt.toISOString());
    assert.strictEqual(view.lastLoginAt, lastLoginAt.toISOString());
  });

  it("leaves optional timestamp fields undefined when absent", () => {
    const record: AdminUserRecord = {
      uid: "uid-2",
      email: "b@example.com",
      role: "superadmin",
      status: "active",
      createdAt: timestamp(new Date()) as unknown as AdminUserRecord["createdAt"],
    };

    const view = serializeAdminUser(record);
    assert.strictEqual(view.updatedAt, undefined);
    assert.strictEqual(view.lastLoginAt, undefined);
  });
});

describe("serializeAdminInvitation", () => {
  it("converts createdAt and acceptedAt to ISO strings and includes email metadata", () => {
    const createdAt = new Date("2025-04-01T00:00:00.000Z");
    const acceptedAt = new Date("2025-04-02T00:00:00.000Z");
    const lastEmailAttemptAt = new Date("2025-04-03T00:00:00.000Z");

    const record: AdminInvitation = {
      id: "inv-1",
      email: "c@example.com",
      role: "admin",
      status: "accepted",
      invitedBy: "uid-creator",
      createdAt:
        timestamp(createdAt) as unknown as AdminInvitation["createdAt"],
      acceptedAt:
        timestamp(acceptedAt) as unknown as AdminInvitation["acceptedAt"],
      acceptedBy: "uid-acceptor",
      emailStatus: "sent",
      lastEmailAttemptAt:
        timestamp(lastEmailAttemptAt) as unknown as AdminInvitation["lastEmailAttemptAt"],
      messageId: "msg-1",
    };

    const view = serializeAdminInvitation(record);
    assert.strictEqual(view.createdAt, createdAt.toISOString());
    assert.strictEqual(view.acceptedAt, acceptedAt.toISOString());
    assert.strictEqual(view.emailStatus, "sent");
    assert.strictEqual(view.lastEmailAttemptAt, lastEmailAttemptAt.toISOString());
    assert.strictEqual(view.messageId, "msg-1");
  });
});
