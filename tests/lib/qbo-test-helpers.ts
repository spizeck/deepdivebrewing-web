// Shared scaffolding for unit tests of the QBO server modules
// (lib/qbo-sync.ts, lib/qbo-tokens.ts, lib/qbo-webhook.ts). Those modules
// carry `import "server-only"` (a throw-only marker the Next.js bundler
// gates on) and talk to Firestore through lib/firebase-admin-db.ts, so
// tests substitute both with module mocks and drive an in-memory
// Firestore stand-in.
//
// The fake models just enough of the Admin SDK surface — collection()
// .doc(), ref.get/update/set, tx.get/create/update inside runTransaction —
// and reproduces the two real-client behaviors the tests rely on:
//   - `undefined` values anywhere in a write are rejected at
//     serialization time (ignoreUndefinedProperties defaults to false)
//   - FieldValue.delete() removes a field; serverTimestamp() stores a
//     marker
import { mock } from "node:test";

type Doc = Record<string, unknown>;

interface FakeSnapshot {
  exists: boolean;
  data(): Doc | undefined;
}

export interface FakeDocRef {
  path: string;
  get(): Promise<FakeSnapshot>;
  update(data: Doc): Promise<void>;
  set(data: Doc): Promise<void>;
}

interface FakeTx {
  get(ref: FakeDocRef): Promise<FakeSnapshot>;
  create(ref: FakeDocRef, data: Doc): void;
  update(ref: FakeDocRef, data: Doc): void;
}

export interface FakeFirestore {
  db: {
    collection(name: string): { doc(id: string): FakeDocRef };
    runTransaction<T>(fn: (tx: FakeTx) => T | Promise<T>): Promise<T>;
  };
  /** Live document contents keyed by "collection/docId". Tests may read
   * or mutate between calls — e.g. to simulate a disconnect landing
   * while a token refresh is in flight. */
  docs: Map<string, Doc>;
  /** Paths whose non-transactional ref.get() should reject — used to
   * prove lookup failures propagate. */
  failGet: Set<string>;
  /** Replaces all stored documents. */
  reset(seed?: Record<string, Doc>): void;
}

function isSentinel(value: unknown, ctorName: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as object).constructor?.name === ctorName
  );
}

// Mirrors the Firestore client's default behavior
// (ignoreUndefinedProperties: false): an `undefined` anywhere in the
// payload fails serialization, so a write accepted here would also be
// accepted by the real SDK.
function assertFirestoreSerializable(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(`Firestore rejected an undefined value at "${path}".`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertFirestoreSerializable(entry, `${path}[${index}]`)
    );
    return;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as object).constructor === Object
  ) {
    for (const [key, entry] of Object.entries(value)) {
      assertFirestoreSerializable(entry, `${path}.${key}`);
    }
  }
}

export function createFakeFirestore(): FakeFirestore {
  const docs = new Map<string, Doc>();
  const failGet = new Set<string>();

  function snapshot(path: string): FakeSnapshot {
    const data = docs.get(path);
    return { exists: data !== undefined, data: () => data };
  }

  function applyWrite(path: string, data: Doc): void {
    assertFirestoreSerializable(data, path);
    const current = docs.get(path) ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (isSentinel(value, "DeleteTransform")) {
        delete current[key];
      } else if (isSentinel(value, "ServerTimestampTransform")) {
        current[key] = "__SERVER_TIMESTAMP__";
      } else {
        current[key] = value;
      }
    }
    docs.set(path, current);
  }

  const tx: FakeTx = {
    get: (ref) => Promise.resolve(snapshot(ref.path)),
    create: (ref, data) => {
      if (docs.has(ref.path)) {
        throw new Error(`Document already exists: ${ref.path}`);
      }
      applyWrite(ref.path, data);
    },
    update: (ref, data) => applyWrite(ref.path, data),
  };

  function docRef(path: string): FakeDocRef {
    return {
      path,
      get: () =>
        failGet.has(path)
          ? Promise.reject(new Error(`Simulated Firestore failure: ${path}`))
          : Promise.resolve(snapshot(path)),
      update: (data) => Promise.resolve(applyWrite(path, data)),
      set: (data) => Promise.resolve(applyWrite(path, data)),
    };
  }

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${name}/${id}`),
    }),
    runTransaction: <T>(fn: (t: FakeTx) => T | Promise<T>) =>
      Promise.resolve(fn(tx)),
  };

  return {
    db,
    docs,
    failGet,
    reset(seed: Record<string, Doc> = {}) {
      docs.clear();
      for (const [path, data] of Object.entries(seed)) {
        docs.set(path, { ...data });
      }
    },
  };
}

// Registers module mocks for "server-only" and the Admin-SDK Firestore
// accessor, then returns the fake the tests drive. Must run before the
// module under test is first imported — call at the top of the test file
// and dynamic-import the module under test inside the tests.
export function installQboDbMock(): FakeFirestore {
  mock.module("server-only", { namedExports: {} });
  const firestore = createFakeFirestore();
  mock.module("@/lib/firebase-admin-db", {
    namedExports: { getFirebaseAdminDb: () => firestore.db },
  });
  return firestore;
}

export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const originals = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    originals.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, original] of originals) {
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  }
}
