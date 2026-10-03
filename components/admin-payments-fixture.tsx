"use client";

// Deterministic rendering of the payments workspace for the Playwright
// accessibility suite — same pattern as admin-trade-fixture.tsx. Rendered
// only by /admin-payments-fixture (gated server-side by
// ADMIN_A11Y_FIXTURE); it never touches Firebase or Stripe, and
// /api/admin/payments* calls are intercepted by Playwright route mocks.
import { AdminPaymentsWorkspace } from "@/components/admin-payments-workspace";

export function AdminPaymentsFixture() {
  return (
    <AdminPaymentsWorkspace user={{ getIdToken: async () => "fixture-token" }} />
  );
}
