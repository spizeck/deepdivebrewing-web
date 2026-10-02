import type { Metadata } from "next";
import { AdminTradePage } from "@/components/admin-trade-page";

export const metadata: Metadata = {
  title: "Trade Leads — Admin",
  description: "Deep Dive Brewing Co admin trade-lead pipeline.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminTradeRoute() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminTradePage />
    </main>
  );
}
