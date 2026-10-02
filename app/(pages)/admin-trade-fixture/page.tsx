import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminTradeFixture } from "@/components/admin-trade-fixture";

// Test-only rendering of the admin trade-lead pipeline — same gate as
// /admin-fixture (ADMIN_A11Y_FIXTURE is set only by the Playwright webServer
// config; normal deployments 404). It grants no access to real data: the
// workspace's API calls are intercepted by Playwright route mocks.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin trade fixture",
  robots: { index: false, follow: false },
};

export default function AdminTradeFixturePage() {
  if (process.env.ADMIN_A11Y_FIXTURE !== "1") {
    notFound();
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminTradeFixture />
    </main>
  );
}
