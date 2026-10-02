"use client";

// Deterministic rendering of the trade-lead pipeline for the Playwright
// accessibility suite — same pattern as admin-fixture.tsx. Rendered only by
// /admin-trade-fixture (gated server-side by ADMIN_A11Y_FIXTURE); it never
// touches Firebase, and /api/admin/trade-leads* calls are intercepted by
// Playwright route mocks.
import { AdminTradeWorkspace } from "@/components/admin-trade-workspace";

export function AdminTradeFixture() {
  return (
    <AdminTradeWorkspace user={{ getIdToken: async () => "fixture-token" }} />
  );
}
