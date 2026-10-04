import type { Metadata } from "next";

// Landing page customers reach if they back out of Stripe's hosted payment
// page (Checkout cancel_url). Static and data-free by design.
export const metadata: Metadata = {
  title: "Payment canceled",
  description: "Your payment was canceled before it completed.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function PayCancelledPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-200 px-6 pb-20 md:pb-30">
      <div className="rounded-lg border border-stone bg-paper p-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Payment canceled</h1>
        <p className="mt-3 text-muted-foreground">
          No charge was made. If you meant to complete the payment, ask the
          brewery for the payment link again — it may need to be re-sent.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          You can close this window.
        </p>
      </div>
    </main>
  );
}
