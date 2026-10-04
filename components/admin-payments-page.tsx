"use client";

import { AdminAuthGate } from "@/components/admin-auth-gate";
import { AdminPaymentsWorkspace } from "@/components/admin-payments-workspace";

export function AdminPaymentsPage() {
  return (
    <AdminAuthGate
      heading="Payments"
      description="Sign in with an authorized Google account to manage payments."
    >
      {(user) => <AdminPaymentsWorkspace user={user} />}
    </AdminAuthGate>
  );
}
