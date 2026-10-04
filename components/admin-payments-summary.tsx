"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { AdminPanelUser } from "@/components/admin-access";
import { formatUsdMinor, type PaymentView } from "@/lib/payments-common";

// Compact entry point into /admin/payments (#155). Loads the same authorized
// list endpoint the workspace uses and derives the actionable numbers; a
// failed load still leaves the working links rather than a broken card.
export function AdminPaymentsSummary({ user }: { user: AdminPanelUser }) {
  const [summary, setSummary] = useState<{
    awaiting: number;
    paidTodayMinor: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/admin/payments", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          payments?: PaymentView[];
        };
        if (cancelled || !res.ok || !data.ok || !data.payments) return;
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        let awaiting = 0;
        let paidTodayMinor = 0;
        for (const p of data.payments) {
          if (p.status === "awaiting_payment" || p.status === "processing") {
            awaiting++;
          }
          if (
            p.status === "paid" &&
            p.paidAt &&
            new Date(p.paidAt).getTime() >= startOfToday.getTime()
          ) {
            paidTodayMinor += p.amountMinor;
          }
        }
        setSummary({ awaiting, paidTodayMinor });
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
      aria-label="Payments summary"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone bg-paper p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">Payments</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {summary
            ? `${summary.awaiting} awaiting · ${formatUsdMinor(summary.paidTodayMinor)} collected today`
            : "Card payments for tours and other one-off charges."}
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/admin/payments">Take payment</Link>
      </Button>
    </section>
  );
}
