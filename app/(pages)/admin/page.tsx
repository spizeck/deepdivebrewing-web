import type { Metadata } from "next";
import { AdminDashboard } from "@/components/admin-dashboard";

export const metadata: Metadata = {
  title: "Admin",
  description: "Deep Dive Brewing Co admin dashboard.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminDashboard />
    </main>
  );
}
