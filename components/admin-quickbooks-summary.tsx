"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { AdminPanelUser } from "@/components/admin-access";
import type { QboAdminView } from "@/lib/qbo-common";

// Compact entry point into /admin/integrations/quickbooks (issue #161) —
// same pattern as the trade-leads summary card: it loads the authorized
// status endpoint and a failed load still leaves a working link.
export function AdminQuickbooksSummary({ user }: { user: AdminPanelUser }) {
  const [connection, setConnection] = useState<QboAdminView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/admin/quickbooks/status", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          connection?: QboAdminView;
        };
        if (cancelled || !res.ok || !data.ok || !data.connection) return;
        setConnection(data.connection);
      } catch {
        // Deliberately quiet — this card is a convenience entry point.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const summary = (() => {
    if (!connection) return "QuickBooks Online integration.";
    switch (connection.status) {
      case "connected":
        return connection.companyName
          ? `Connected to ${connection.companyName} (${connection.environmentLabel}).`
          : `Connected (${connection.environmentLabel}).`;
      case "reauthorization_required":
        return "QuickBooks needs to be reconnected.";
      case "not_configured":
        return "QuickBooks is not configured on this deployment.";
      default:
        return "QuickBooks is not connected.";
    }
  })();

  return (
    <section
      aria-label="QuickBooks summary"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone bg-paper p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">QuickBooks</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/admin/integrations/quickbooks">Open QuickBooks</Link>
      </Button>
    </section>
  );
}
