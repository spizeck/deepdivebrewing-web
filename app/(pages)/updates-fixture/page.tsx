import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UpdatesArchive } from "@/components/updates-archive";
import {
  UPDATES_FIXTURE_MANY,
  UPDATES_FIXTURE_SINGLE,
} from "@/lib/updates-fixture";
import type { Update } from "@/lib/updates";

// Test-only rendering of the /updates archive experience for the
// Playwright smoke suite, covering the layouts the seeded content cannot
// reach (empty and multi-post). The env var is a server-only check
// evaluated per request (force-dynamic): it is set exclusively by the
// Playwright webServer config, so in any normal deployment — including
// Vercel builds — this route returns 404 and serves nothing.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Updates fixture",
  robots: { index: false, follow: false },
};

interface UpdatesFixturePageProps {
  searchParams: Promise<{ state?: string }>;
}

export default async function UpdatesFixturePage({
  searchParams,
}: UpdatesFixturePageProps) {
  if (process.env.UPDATES_FIXTURE !== "1") {
    notFound();
  }

  const { state } = await searchParams;
  const updates: Update[] =
    state === "single"
      ? UPDATES_FIXTURE_SINGLE
      : state === "empty"
        ? []
        : UPDATES_FIXTURE_MANY;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-300 px-6 pb-20 md:pb-30"
    >
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Updates
        </h1>
      </div>
      <UpdatesArchive updates={updates} basePath="/updates-fixture" />
    </main>
  );
}
