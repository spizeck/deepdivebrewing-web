import type { Metadata } from "next";
import { AdminKnowledgeHistoryPage } from "@/components/admin-knowledge-history";

export const metadata: Metadata = {
  title: "History — Knowledge Base",
  description: "Deep Dive Brewing Co knowledge base revision history.",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AdminKnowledgeHistoryRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminKnowledgeHistoryPage slug={decodeURIComponent(slug)} />
    </main>
  );
}
