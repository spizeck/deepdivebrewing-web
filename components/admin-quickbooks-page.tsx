"use client";

import { AdminAuthGate } from "@/components/admin-auth-gate";
import { AdminQuickbooksWorkspace } from "@/components/admin-quickbooks-workspace";

export function AdminQuickbooksPage() {
  return (
    <AdminAuthGate heading="QuickBooks">
      {(user) => <AdminQuickbooksWorkspace user={user} />}
    </AdminAuthGate>
  );
}
