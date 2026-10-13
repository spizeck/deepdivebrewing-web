// Firestore write boundary: Firestore rejects `undefined` values anywhere
// in a document payload — nested objects and arrays included — and we
// deliberately do not enable `ignoreUndefinedProperties` globally, since
// silently dropping fields would hide real bugs in every other write.
// Optional report fields (a missing DocNumber, an unmapped account
// balance, a flag without an amount) are legitimate "absent" data; this
// helper turns them into actually-absent keys before persistence.
//
// Semantics mirror JSON.stringify: object properties whose value is
// `undefined` are omitted, `undefined` array elements become `null`
// (Firestore stores null; dropping them would silently shift indices).
// Non-plain objects — FieldValue sentinels, Timestamps, Dates, class
// instances — pass through untouched. The input is never mutated; plain
// objects and arrays are rebuilt.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepOmitUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : deepOmitUndefined(item)
    ) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = deepOmitUndefined(entry);
    }
    return out as T;
  }
  return value;
}
