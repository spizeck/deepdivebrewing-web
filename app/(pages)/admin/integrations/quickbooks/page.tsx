import type { Metadata } from "next";
import { AdminQuickbooksPage } from "@/components/admin-quickbooks-page";

export const metadata: Metadata = {
  title: "QuickBooks — Admin",
  description: "Deep Dive Brewing Co QuickBooks Online integration.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminQuickbooksRoute() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminQuickbooksPage />
    </main>
  );
}
