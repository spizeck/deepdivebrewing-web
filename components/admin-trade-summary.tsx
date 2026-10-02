"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { AdminPanelUser } from "@/components/admin-access";
import {
  classifyFollowUp,
  type TradeLeadView,
} from "@/lib/trade-leads-admin-common";

interface SummaryCounts {
  fresh: number;
  dueToday: number;
  overdue: number;
}

// Compact entry point into /admin/trade (#150). Loads the same authorized
// list endpoint the pipeline page uses and derives the actionable counts;
// a failed load still leaves the working link rather than a broken card.
export function AdminTradeSummary({ user }: { user: AdminPanelUser }) {
  const [counts, setCounts] = useState<SummaryCounts | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/admin/trade-leads", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          leads?: TradeLeadView[];
        };
        if (cancelled || !res.ok || !data.ok || !data.leads) return;
        const next: SummaryCounts = { fresh: 0, dueToday: 0, overdue: 0 };
        for (const lead of data.leads) {
          if (lead.status === "new") next.fresh++;
          const state = classifyFollowUp(lead.nextFollowUpAt, lead.status);
          if (state === "due_today") next.dueToday++;
          else if (state === "overdue") next.overdue++;
        }
        setCounts(next);
      } catch {
        // Deliberately quiet — this card is a convenience entry point, not
        // the operational surface itself.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <section
      aria-label="Trade leads summary"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone bg-paper p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">Trade leads</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {counts
            ? `${counts.fresh} new · ${counts.dueToday} due today · ${counts.overdue} overdue`
            : "New inquiries and follow-ups live in the trade pipeline."}
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/admin/trade">Open pipeline</Link>
      </Button>
    </section>
  );
}
