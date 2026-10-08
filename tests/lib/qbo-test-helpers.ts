// Shared scaffolding for unit tests of the QBO server modules
// (lib/qbo-sync.ts, lib/qbo-tokens.ts, lib/qbo-webhook.ts). Those modules
// carry `import "server-only"` (a throw-only marker the Next.js bundler
// gates on) and talk to Firestore through lib/firebase-admin-db.ts, so
// tests substitute both with module mocks and drive an in-memory
// Firestore stand-in.
//
// The fake models just enough of the Admin SDK surface — collection()
// .doc(), ref.get/update/set, tx.get/create/update inside runTransaction,
// plus bounded where/orderBy/limit/count queries — and reproduces the two
// real-client behaviors the tests rely on:
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
  collection(name: string): { doc(id?: string): FakeDocRef };
  get(): Promise<FakeSnapshot>;
  update(data: Doc): Promise<void>;
  set(data: Doc): Promise<void>;
}

export interface FakeQueryDoc {
  id: string;
  ref: FakeDocRef;
  exists: boolean;
  data(): Doc;
}

export interface FakeQuerySnapshot {
  empty: boolean;
  size: number;
  docs: FakeQueryDoc[];
}

export interface FakeQuery {
  where(field: string, op: string, value: unknown): FakeQuery;
  orderBy(field: string, direction?: "asc" | "desc"): FakeQuery;
  startAfter(value: unknown): FakeQuery;
  limit(n: number): FakeQuery;
  get(): Promise<FakeQuerySnapshot>;
  count(): { get(): Promise<{ data(): { count: number } }> };
}

export interface FakeCollectionRef extends FakeQuery {
  doc(id?: string): FakeDocRef;
}

interface FakeTx {
  get(ref: FakeDocRef): Promise<FakeSnapshot>;
  create(ref: FakeDocRef, data: Doc): void;
  update(ref: FakeDocRef, data: Doc): void;
  set(ref: FakeDocRef, data: Doc): void;
}

export interface FakeFirestore {
  db: {
    collection(name: string): FakeCollectionRef;
    runTransaction<T>(fn: (tx: FakeTx) => T | Promise<T>): Promise<T>;
    batch(): { update(ref: FakeDocRef, data: Doc): void; commit(): Promise<void> };
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
    set: (ref, data) => applyWrite(ref.path, data),
  };

  let autoIdCounter = 0;
  // Stand-in for Firestore's client-generated document id — unique per
  // test run and clearly synthetic.
  const autoId = () => `__auto_${++autoIdCounter}`;

  function docRef(path: string): FakeDocRef {
    return {
      path,
      collection: (name: string) => ({
        doc: (id?: string) => docRef(`${path}/${name}/${id ?? autoId()}`),
      }),
      get: () =>
        failGet.has(path)
          ? Promise.reject(new Error(`Simulated Firestore failure: ${path}`))
          : Promise.resolve(snapshot(path)),
      update: (data) => Promise.resolve(applyWrite(path, data)),
      set: (data) => Promise.resolve(applyWrite(path, data)),
    };
  }

  // --- Query support (where/orderBy/limit/count) ---
  //
  // Mirrors the real SDK semantics the sweep/admin code relies on:
  //   - a document must CONTAIN a field to match any operator on it
  //   - cross-type ordering follows Firestore (null < bool < number <
  //     timestamp < string < array < object)
  //   - orderBy also excludes documents missing the field
  //   - only top-level collection documents match (collection/docId)

  function valueRank(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === "boolean") return 1;
    if (typeof value === "number") return 2;
    if (
      value instanceof Date ||
      (typeof value === "object" &&
        value !== null &&
        typeof (value as { toMillis?: unknown }).toMillis === "function")
    )
      return 3;
    if (typeof value === "string") return 4;
    if (Array.isArray(value)) return 5;
    return 6;
  }

  function asMillis(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    return (value as { toMillis(): number }).toMillis();
  }

  function compareValues(a: unknown, b: unknown): number {
    const ra = valueRank(a);
    const rb = valueRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 3) return asMillis(a) - asMillis(b);
    if (a === b) return 0;
    if (typeof a === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof a === "number") return a - (b as number);
    if (typeof a === "string") return a < (b as string) ? -1 : 1;
    return 0;
  }

  interface Filter {
    field: string;
    op: string;
    value: unknown;
  }

  function matchesFilter(data: Doc, filter: Filter): boolean {
    const actual = data[filter.field];
    if (actual === undefined) return false;
    switch (filter.op) {
      case "==":
        return compareValues(actual, filter.value) === 0;
      case "!=":
        return compareValues(actual, filter.value) !== 0;
      case "in":
        return (
          Array.isArray(filter.value) &&
          filter.value.some((v) => compareValues(actual, v) === 0)
        );
      case ">":
        return compareValues(actual, filter.value) > 0;
      case ">=":
        return compareValues(actual, filter.value) >= 0;
      case "<":
        return compareValues(actual, filter.value) < 0;
      case "<=":
        return compareValues(actual, filter.value) <= 0;
      default:
        throw new Error(`Unsupported query operator: ${filter.op}`);
    }
  }

  function makeQuery(
    collectionName: string,
    filters: Filter[] = [],
    orders: { field: string; direction: "asc" | "desc" }[] = [],
    limitN: number | null = null,
    startAfterValue?: { value: unknown }
  ): FakeQuery {
    const run = (): FakeQueryDoc[] => {
      const prefix = `${collectionName}/`;
      let rows = [...docs.entries()].filter(
        ([path]) =>
          path.startsWith(prefix) &&
          !path.slice(prefix.length).includes("/")
      );
      rows = rows.filter(([, data]) =>
        filters.every((f) => matchesFilter(data, f))
      );
      for (const order of orders) {
        rows = rows.filter(([, data]) => data[order.field] !== undefined);
      }
      if (orders.length) {
        rows = [...rows].sort(([, a], [, b]) => {
          for (const order of orders) {
            const cmp = compareValues(a[order.field], b[order.field]);
            if (cmp !== 0) return order.direction === "desc" ? -cmp : cmp;
          }
          return 0;
        });
      }
      if (startAfterValue) {
        // Cursors bind to the last orderBy field — the only shape the
        // swept/admin queries use.
        const order = orders[orders.length - 1];
        if (!order) {
          throw new Error("startAfter requires at least one orderBy");
        }
        rows = rows.filter(([, data]) => {
          const cmp = compareValues(data[order.field], startAfterValue.value);
          return order.direction === "desc" ? cmp < 0 : cmp > 0;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows.map(([path, data]) => ({
        id: path.slice(prefix.length),
        ref: docRef(path),
        exists: true,
        data: () => data,
      }));
    };
    return {
      where: (field, op, value) =>
        makeQuery(collectionName, [...filters, { field, op, value }], orders, limitN, startAfterValue),
      orderBy: (field, direction = "asc") =>
        makeQuery(collectionName, filters, [...orders, { field, direction }], limitN, startAfterValue),
      startAfter: (value) =>
        makeQuery(collectionName, filters, orders, limitN, { value }),
      limit: (n) => makeQuery(collectionName, filters, orders, n, startAfterValue),
      get: () => {
        const results = run();
        return Promise.resolve({
          empty: results.length === 0,
          size: results.length,
          docs: results,
        });
      },
      count: () => ({
        get: () => Promise.resolve({ data: () => ({ count: run().length }) }),
      }),
    };
  }

  const db = {
    collection: (name: string): FakeCollectionRef =>
      Object.assign(
        { doc: (id?: string) => docRef(`${name}/${id ?? autoId()}`) },
        makeQuery(name)
      ),
    runTransaction: <T>(fn: (t: FakeTx) => T | Promise<T>) =>
      Promise.resolve(fn(tx)),
    batch: () => {
      const writes: [string, Doc][] = [];
      return {
        update: (ref: FakeDocRef, data: Doc) => {
          writes.push([ref.path, data]);
        },
        commit: () => {
          for (const [path, data] of writes) applyWrite(path, data);
          return Promise.resolve();
        },
      };
    },
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

// Real-behavior stand-ins for the two qbo-tokens exports the sync claim
// path consults — spread into tests' `@/lib/qbo-tokens` module mocks so
// the pause gate sees the same fake connection doc production would.
export function qboTokensMockExtras(firestore: FakeFirestore) {
  return {
    qboConnectionRef: (environment: string) =>
      firestore.db.collection("qboConnections").doc(environment),
    usableQboConnection: (
      data: Record<string, unknown> | undefined,
      environment: string
    ): Record<string, unknown> | null =>
      data && (!data.environment || data.environment === environment)
        ? data
        : null,
  };
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
