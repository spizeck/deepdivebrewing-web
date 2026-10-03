import type { Metadata } from "next";
import { AdminPaymentsPage } from "@/components/admin-payments-page";

export const metadata: Metadata = {
  title: "Payments — Admin",
  description: "Deep Dive Brewing Co admin payment workspace.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminPaymentsRoute() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminPaymentsPage />
    </main>
  );
}
