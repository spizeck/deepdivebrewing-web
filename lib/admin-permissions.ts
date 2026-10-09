// Capability-based permissions for sensitive admin surfaces (issue #210).
//
// The canonical store is the `permissions` array on the adminUsers/{uid}
// Firestore record — NOT Firebase custom claims. The record is read live on
// every privileged API request (see requireAdminActor in lib/admin-auth.ts),
// so a permission grant or revoke takes effect on the very next request with
// no token refresh and no stale-claim window. Claims continue to carry only
// { admin, role } because the Firestore/Storage security rules need them for
// the dashboard's direct client reads; every permission-protected collection
// is already deny-all to clients and reachable only through Admin SDK API
// routes, so the server-side record check is the complete authorization path.
//
// Compatibility rule (rollout): a superadmin holds every permission
// implicitly, so the protected bootstrap owner can never be locked out and
// no data migration is required. An `admin`-role record without a
// `permissions` field has none — existing ordinary admins move to least
// privilege automatically and a superadmin grants capabilities explicitly.
//
// Deliberately unpermissioned for now (plain admin role still suffices):
// beers/venues, rebuilds, the Knowledge Base, and the trade-leads pipeline.
// Extending coverage means adding a key here and switching the surface's
// routes to requireAdminPermission — nothing else changes.

export const ADMIN_PERMISSIONS = ["accounting", "payments"] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

// Human-facing copy for the admin-management UI — internal keys must not be
// the primary labels a non-technical owner reads.
export const ADMIN_PERMISSION_LABELS: Record<
  AdminPermission,
  { label: string; description: string }
> = {
  accounting: {
    label: "QuickBooks & Accounting",
    description:
      "Connect QuickBooks, edit accounting mappings, and view or retry sync records.",
  },
  payments: {
    label: "Take Payments",
    description:
      "Create and manage card/cash payments, issue links and refunds.",
  },
};

export function isAdminPermission(value: unknown): value is AdminPermission {
  return (
    typeof value === "string" &&
    (ADMIN_PERMISSIONS as readonly string[]).includes(value)
  );
}

// Fail-closed normalization for client-supplied permission lists: anything
// other than an array of known permission keys returns null so callers can
// reject the request instead of silently dropping unknown entries.
export function normalizeAdminPermissions(
  input: unknown
): AdminPermission[] | null {
  if (!Array.isArray(input)) return null;
  const result: AdminPermission[] = [];
  for (const entry of input) {
    if (!isAdminPermission(entry)) return null;
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

export type AdminPermissionSource = {
  // Typed as string (not AdminRole) so this module stays dependency-free and
  // client-safe — lib/types.ts itself imports AdminPermission from here.
  role: string;
  permissions?: unknown;
};

// The effective capability set for an admin record. Superadmin is all-powerful
// by role; ordinary admins get exactly the stored, recognized permissions —
// unknown stored values are ignored rather than trusted.
export function recordPermissions(
  record: AdminPermissionSource | null | undefined
): AdminPermission[] {
  if (!record) return [];
  if (record.role === "superadmin") return [...ADMIN_PERMISSIONS];
  if (!Array.isArray(record.permissions)) return [];
  return record.permissions.filter(isAdminPermission);
}

export function recordHasPermission(
  record: AdminPermissionSource | null | undefined,
  permission: AdminPermission
): boolean {
  return recordPermissions(record).includes(permission);
}
