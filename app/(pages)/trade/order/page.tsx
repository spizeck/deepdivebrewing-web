// TODO: Implement trade ordering when requested
import type { Metadata } from "next";

// Reserved placeholder — not a useful public search result.
export const metadata: Metadata = {
  title: "Trade Order",
  robots: { index: false, follow: false },
};

export default function TradeOrderPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Place an Order</h1>
      <p className="mt-2 text-muted-foreground">Coming soon.</p>
    </main>
  );
}
