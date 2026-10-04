"use client";

// Deterministic rendering of the QuickBooks integration surface for the
// Playwright suite — same pattern as admin-trade-fixture.tsx. Rendered only
// by /admin-quickbooks-fixture (gated server-side by ADMIN_A11Y_FIXTURE);
// it never touches Firebase, and /api/admin/quickbooks* calls are
// intercepted by Playwright route mocks.
import { AdminQuickbooksWorkspace } from "@/components/admin-quickbooks-workspace";

export function AdminQuickbooksFixture() {
  return (
    <AdminQuickbooksWorkspace
      user={{ getIdToken: async () => "fixture-token" }}
    />
  );
}
