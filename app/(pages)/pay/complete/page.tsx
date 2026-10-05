import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";

// Landing page customers reach after paying on Stripe's hosted page
// (Checkout success_url). Static and data-free by design — payment state is
// reconciled by the Stripe webhook, never by this page load.
export const metadata: Metadata = {
  title: "Payment received",
  description: "Your payment to Deep Dive Brewing Co was received.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function PayCompletePage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-200 px-6 pb-20 md:pb-30">
      <div className="rounded-lg border border-moss/30 bg-moss/5 p-8 text-center">
        <BrandMark
          tone="black"
          size={56}
          decorative
          className="mx-auto opacity-80"
        />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">Payment received</h1>
        <p className="mt-3 text-muted-foreground">
          Thank you — your payment to Deep Dive Brewing Co was received. If
          you asked for a receipt, it is on its way to your inbox.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          You can close this window.
        </p>
      </div>
    </main>
  );
}
