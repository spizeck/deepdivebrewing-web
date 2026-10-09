import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminKnowledgeFixture } from "@/components/admin-knowledge-fixture";

// Test-only Knowledge Base fixture — same pattern as /admin-trade-fixture.
// KNOWLEDGE_FIXTURE is set only by the Playwright webServer config; normal
// deployments 404. ?view=landing|article|draft|missing|edit|new|history
// selects the surface.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin knowledge fixture",
  robots: { index: false, follow: false },
};

export default async function AdminKnowledgeFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (process.env.KNOWLEDGE_FIXTURE !== "1") {
    notFound();
  }
  const { view } = await searchParams;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminKnowledgeFixture view={view ?? "landing"} />
    </main>
  );
}
