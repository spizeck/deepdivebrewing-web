import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminFixture } from "@/components/admin-fixture";

// Test-only rendering of the authenticated admin workspace for the Playwright
// accessibility suite. The env var is a server-only check evaluated per
// request (force-dynamic): it is set exclusively by the Playwright webServer
// config, so in any normal deployment — including Vercel builds — this route
// returns 404 and serves nothing. It grants no access to real data: the
// workspace renders hardcoded fixture records and never reaches Firebase;
// the real /admin flow is unchanged.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin fixture",
  robots: { index: false, follow: false },
};

export default async function AdminFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  if (process.env.ADMIN_A11Y_FIXTURE !== "1") {
    notFound();
  }

  const { role } = await searchParams;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminFixture role={role === "admin" ? "admin" : "superadmin"} />
    </main>
  );
}
