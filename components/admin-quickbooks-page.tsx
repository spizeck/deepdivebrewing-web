"use client";

import { AdminAuthGate } from "@/components/admin-auth-gate";
import { AdminQuickbooksWorkspace } from "@/components/admin-quickbooks-workspace";

export function AdminQuickbooksPage() {
  return (
    <AdminAuthGate
      heading="QuickBooks"
      description="Sign in with an authorized Google account to manage the QuickBooks integration."
    >
      {(user) => <AdminQuickbooksWorkspace user={user} />}
    </AdminAuthGate>
  );
}
