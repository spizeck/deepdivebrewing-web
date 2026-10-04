"use client";

import { AdminAuthGate } from "@/components/admin-auth-gate";
import { AdminPaymentsWorkspace } from "@/components/admin-payments-workspace";

export function AdminPaymentsPage() {
  return (
    <AdminAuthGate heading="Payments">
      {(user) => <AdminPaymentsWorkspace user={user} />}
    </AdminAuthGate>
  );
}
