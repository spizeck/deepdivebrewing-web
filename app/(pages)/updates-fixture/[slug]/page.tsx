import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Test-only stub detail for /updates-fixture archive links (Issue #194):
// fixture entries link to real-looking detail URLs, so the archive's
// prefetches must resolve somewhere — any slug serves a placeholder while
// the gate is on, and the route 404s in every normal deployment.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Updates fixture detail",
  robots: { index: false, follow: false },
};

interface UpdatesFixtureDetailProps {
  params: Promise<{ slug: string }>;
}

export default async function UpdatesFixtureDetailPage({
  params,
}: UpdatesFixtureDetailProps) {
  if (process.env.UPDATES_FIXTURE !== "1") {
    notFound();
  }
  const { slug } = await params;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-300 px-6 pb-20 md:pb-30"
    >
      <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
        Fixture Update Detail
      </h1>
      <p className="mt-3 text-muted-foreground">Fixture slug: {slug}</p>
    </main>
  );
}
