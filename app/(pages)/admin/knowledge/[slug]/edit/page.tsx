import type { Metadata } from "next";
import { AdminKnowledgeEditorPage } from "@/components/admin-knowledge-editor";

export const metadata: Metadata = {
  title: "Edit Article — Knowledge Base",
  description: "Deep Dive Brewing Co internal knowledge base editor.",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AdminKnowledgeEditRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminKnowledgeEditorPage slug={slug} />
    </main>
  );
}
