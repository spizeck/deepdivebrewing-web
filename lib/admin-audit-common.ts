export function dropUndefinedValues(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(dropUndefinedValues);

  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(
    entries.map(([k, v]) => [k, dropUndefinedValues(v)])
  );
}
