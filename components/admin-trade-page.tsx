"use client";

import { AdminAuthGate } from "@/components/admin-auth-gate";
import { AdminTradeWorkspace } from "@/components/admin-trade-workspace";

export function AdminTradePage() {
  return (
    <AdminAuthGate
      heading="Trade Leads"
      description="Sign in with an authorized Google account to manage trade leads."
    >
      {(user) => <AdminTradeWorkspace user={user} />}
    </AdminAuthGate>
  );
}
