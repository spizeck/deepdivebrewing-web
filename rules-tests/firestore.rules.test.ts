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
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

// Each rules test file uses its own demo project: node:test runs test files
// in parallel, and clearFirestore() only wipes the caller's project, so
// separate projectIds keep the suites isolated on the shared emulator.
const PROJECT_ID = "demo-deepdivebrewing-web-firestore";

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

function seedBeer(
  slug: string,
  isPublic: boolean
): Promise<void> {
  return testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "beers", slug), {
      slug,
      name: slug,
      isPublic,
      sortOrder: 1,
    });
  });
}

const validTradeLead = {
  businessName: "Test Venue",
  contactName: "Test Contact",
  email: "venue@example.com",
  phoneOrWhatsapp: "+599 000 0000",
  venueType: "bar",
  message: "We would like to carry your beer.",
  status: "new",
  source: "trade_form",
  createdAt: 0,
  updatedAt: 0,
};

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8180,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe("beers and venues content writes", () => {
  it("allows an active admin with matching claims to write", async () => {
    await seedAdminRecord("admin1", "admin", "active");
    const db = adminContext("admin1", "admin").firestore();
    await assertSucceeds(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
    await assertSucceeds(
      setDoc(doc(db, "venues", "new-venue"), { slug: "new-venue", name: "Venue", island: "saba", isPublic: true })
    );
  });

  it("requires a canonical island value on venue writes (Issue #134)", async () => {
    await seedAdminRecord("admin1", "admin", "active");
    const db = adminContext("admin1", "admin").firestore();

    for (const island of ["saba", "sxm", "statia"]) {
      await assertSucceeds(
        setDoc(doc(db, "venues", `ok-${island}`), { slug: `ok-${island}`, island, isPublic: true })
      );
    }

    // Missing, free-text, and locality-shaped islands are all rejected —
    // "Philipsburg" must never be storable as an island again.
    await assertFails(
      setDoc(doc(db, "venues", "no-island"), { slug: "no-island", name: "V", isPublic: true })
    );
    await assertFails(
      setDoc(doc(db, "venues", "bad-island"), { slug: "bad-island", island: "Philipsburg", isPublic: true })
    );
    await assertFails(
      setDoc(doc(db, "venues", "bad-island-2"), { slug: "bad-island-2", island: "bonaire", isPublic: true })
    );

    // An update that keeps the merged doc's valid island is allowed.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "venues", "existing"), { slug: "existing", island: "sxm", isPublic: true });
    });
    await assertSucceeds(
      updateDoc(doc(db, "venues", "existing"), { name: "Renamed" })
    );
  });

  it("allows an active superadmin with matching claims to write", async () => {
    await seedAdminRecord("super1", "superadmin", "active");
    const db = adminContext("super1", "superadmin").firestore();
    await assertSucceeds(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies a stale admin claim when the adminUsers record is missing", async () => {
    const db = adminContext("ghost", "admin").firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
    await assertFails(setDoc(doc(db, "meta", "siteRebuild"), { lastTriggeredAt: 1 }));
  });

  it("denies a stale superadmin claim when the adminUsers record is missing", async () => {
    const db = adminContext("ghost", "superadmin").firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies a stale admin claim when the record is disabled", async () => {
    await seedAdminRecord("admin1", "admin", "disabled");
    const db = adminContext("admin1", "admin").firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies a stale superadmin claim when the record is disabled", async () => {
    await seedAdminRecord("super1", "superadmin", "disabled");
    const db = adminContext("super1", "superadmin").firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies a stale superadmin claim after demotion (record says admin)", async () => {
    await seedAdminRecord("demoted", "admin", "active");
    const db = adminContext("demoted", "superadmin").firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies a stale admin claim after promotion (record says superadmin)", async () => {
    await seedAdminRecord("promoted", "superadmin", "active");
    const db = adminContext("promoted", "admin").firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies an admin claim with no role claim", async () => {
    await seedAdminRecord("norole", "admin", "active");
    const db = testEnv.authenticatedContext("norole", { admin: true }).firestore();
    await assertFails(
      setDoc(doc(db, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });

  it("denies unauthenticated and ordinary authenticated writes", async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(anonDb, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );

    const userDb = testEnv.authenticatedContext("plain-user").firestore();
    await assertFails(
      setDoc(doc(userDb, "beers", "new-beer"), { slug: "new-beer", name: "New", isPublic: true })
    );
  });
});

describe("reads", () => {
  it("keeps public document reads open to everyone", async () => {
    await seedBeer("public-beer", true);
    await seedBeer("private-beer", false);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anonDb, "beers", "public-beer")));
    await assertFails(getDoc(doc(anonDb, "beers", "private-beer")));
    await assertSucceeds(
      getDocs(query(collection(anonDb, "beers"), where("isPublic", "==", true)))
    );
  });

  it("lets an active admin read non-public docs but not a disabled admin", async () => {
    await seedBeer("private-beer", false);
    await seedAdminRecord("admin1", "admin", "active");
    await seedAdminRecord("admin2", "admin", "disabled");

    const activeDb = adminContext("admin1", "admin").firestore();
    await assertSucceeds(getDoc(doc(activeDb, "beers", "private-beer")));
    await assertSucceeds(getDocs(query(collection(activeDb, "beers"))));

    const disabledDb = adminContext("admin2", "admin").firestore();
    await assertFails(getDoc(doc(disabledDb, "beers", "private-beer")));
  });
});

describe("meta collection", () => {
  it("requires an active matching admin record for rebuild metadata", async () => {
    await seedAdminRecord("admin1", "admin", "active");
    const db = adminContext("admin1", "admin").firestore();
    await assertSucceeds(
      setDoc(doc(db, "meta", "siteRebuild"), { lastTriggeredAt: 1 }, { merge: true })
    );
    await assertSucceeds(getDoc(doc(db, "meta", "siteRebuild")));
  });
});

describe("superadmin collections", () => {
  it("lets an active superadmin manage adminUsers and invitations", async () => {
    await seedAdminRecord("super1", "superadmin", "active");
    const db = adminContext("super1", "superadmin").firestore();
    await assertSucceeds(
      setDoc(doc(db, "adminUsers", "other"), { uid: "other", role: "admin", status: "active" })
    );
    await assertSucceeds(
      setDoc(doc(db, "adminInvitations", "inv1"), { email: "x@example.com", status: "pending" })
    );
    await assertSucceeds(
      addDoc(collection(db, "adminAuditLogs"), { action: "update_admin" })
    );
  });

  it("denies admin collections to admins, stale claims, and non-admins", async () => {
    await seedAdminRecord("admin1", "admin", "active");
    await seedAdminRecord("demoted", "admin", "active");

    const adminDb = adminContext("admin1", "admin").firestore();
    await assertFails(getDoc(doc(adminDb, "adminUsers", "admin1")));
    await assertFails(
      setDoc(doc(adminDb, "adminUsers", "other"), { uid: "other", role: "admin" })
    );

    // Stale superadmin claim whose record now says "admin".
    const staleDb = adminContext("demoted", "superadmin").firestore();
    await assertFails(getDoc(doc(staleDb, "adminUsers", "admin1")));

    const userDb = testEnv.authenticatedContext("plain-user").firestore();
    await assertFails(getDoc(doc(userDb, "adminUsers", "admin1")));
  });

  it("keeps audit logs immutable even for active superadmins", async () => {
    await seedAdminRecord("super1", "superadmin", "active");
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "adminAuditLogs", "log1"), { action: "update_admin" });
    });
    const db = adminContext("super1", "superadmin").firestore();
    await assertSucceeds(getDoc(doc(db, "adminAuditLogs", "log1")));
    await assertFails(updateDoc(doc(db, "adminAuditLogs", "log1"), { action: "x" }));
  });
});

describe("tradeLeads denies all client access", () => {
  it("denies unauthenticated creates, even with the persisted schema", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(addDoc(collection(db, "tradeLeads"), validTradeLead));
  });

  it("denies unauthenticated reads", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tradeLeads", "lead1"), validTradeLead);
    });
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "tradeLeads", "lead1")));
    await assertFails(getDocs(collection(db, "tradeLeads")));
  });

  it("denies authenticated non-admin creates and reads", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tradeLeads", "lead1"), validTradeLead);
    });
    const db = testEnv.authenticatedContext("visitor1").firestore();
    await assertFails(addDoc(collection(db, "tradeLeads"), validTradeLead));
    await assertFails(getDoc(doc(db, "tradeLeads", "lead1")));
  });

  it("denies even active admins — leads are written/read server-side only", async () => {
    await seedAdminRecord("admin1", "admin", "active");
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tradeLeads", "lead1"), validTradeLead);
    });
    const db = adminContext("admin1", "admin").firestore();
    await assertFails(getDoc(doc(db, "tradeLeads", "lead1")));
    await assertFails(addDoc(collection(db, "tradeLeads"), validTradeLead));
    await assertFails(
      updateDoc(doc(db, "tradeLeads", "lead1"), { status: "contacted" })
    );
    await assertFails(
      deleteDoc(doc(db, "tradeLeads", "lead1"))
    );
  });
});
