import { after, before, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";

// Must match the --project passed to `firebase emulators:exec`: the Storage
// emulator resolves cross-service firestore.get() calls against that project,
// not the request's projectId. The Firestore suite uses its own demo project
// so the parallel test files' clearFirestore() calls stay isolated.
const PROJECT_ID = "demo-deepdivebrewing-web";

let testEnv: RulesTestEnvironment;

function adminContext(
  uid: string,
  role: "admin" | "superadmin"
): RulesTestContext {
  return testEnv.authenticatedContext(uid, { admin: true, role });
}

function seedAdminRecord(
  uid: string,
  role: "admin" | "superadmin",
  status: "active" | "disabled"
): Promise<void> {
  return testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "adminUsers", uid), {
      uid,
      email: `${uid}@example.com`,
      role,
      status,
    });
  });
}

function seedObject(objectPath: string): Promise<void> {
  return testEnv.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), objectPath), new Uint8Array([1, 2, 3]));
  });
}

const imageBytes = new Uint8Array([137, 80, 78, 71]);

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8180,
    },
    storage: {
      rules: fs.readFileSync(path.join(process.cwd(), "storage.rules"), "utf8"),
      host: "127.0.0.1",
      port: 9299,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

describe("storage writes", () => {
  it("allows an active admin with matching claims to upload", async () => {
    await seedAdminRecord("admin1", "admin", "active");
    const storage = adminContext("admin1", "admin").storage();
    await assertSucceeds(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("allows an active superadmin with matching claims to upload", async () => {
    await seedAdminRecord("super1", "superadmin", "active");
    const storage = adminContext("super1", "superadmin").storage();
    await assertSucceeds(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("denies a stale admin claim when the adminUsers record is missing", async () => {
    const storage = adminContext("ghost", "admin").storage();
    await assertFails(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("denies a stale superadmin claim when the adminUsers record is missing", async () => {
    const storage = adminContext("ghost", "superadmin").storage();
    await assertFails(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("denies a stale claim when the record is disabled", async () => {
    await seedAdminRecord("admin1", "admin", "disabled");
    const storage = adminContext("admin1", "admin").storage();
    await assertFails(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("denies a stale superadmin claim after demotion (record says admin)", async () => {
    await seedAdminRecord("demoted", "admin", "active");
    const storage = adminContext("demoted", "superadmin").storage();
    await assertFails(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("denies a stale admin claim after promotion (record says superadmin)", async () => {
    await seedAdminRecord("promoted", "superadmin", "active");
    const storage = adminContext("promoted", "admin").storage();
    await assertFails(
      uploadBytes(ref(storage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });

  it("denies unauthenticated and ordinary authenticated uploads", async () => {
    const anonStorage = testEnv.unauthenticatedContext().storage();
    await assertFails(
      uploadBytes(ref(anonStorage, "beers/new-beer/card.jpg"), imageBytes)
    );

    const userStorage = testEnv.authenticatedContext("plain-user").storage();
    await assertFails(
      uploadBytes(ref(userStorage, "beers/new-beer/card.jpg"), imageBytes)
    );
  });
});

describe("storage reads", () => {
  it("keeps object reads open to everyone", async () => {
    await seedObject("beers/existing/card.jpg");
    const anonStorage = testEnv.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(anonStorage, "beers/existing/card.jpg")));
  });
});
