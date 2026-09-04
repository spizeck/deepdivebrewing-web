export function dropUndefinedValues(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(dropUndefinedValues);
  // Only recurse into plain objects so Firestore Timestamp, Date, and other
  // class instances are preserved as typed values.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(
    entries.map(([k, v]) => [k, dropUndefinedValues(v)])
  );
}
