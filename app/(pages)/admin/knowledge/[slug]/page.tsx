import type { Metadata } from "next";
import { AdminKnowledgeArticlePage } from "@/components/admin-knowledge-article";

// Titles stay generic — article names are internal and must not leak into
// crawlable metadata even though the content itself is admin-gated.
export const metadata: Metadata = {
  title: "Article — Knowledge Base",
  description: "Deep Dive Brewing Co internal knowledge base article.",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AdminKnowledgeArticleRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminKnowledgeArticlePage slug={decodeURIComponent(slug)} />
    </main>
  );
}
