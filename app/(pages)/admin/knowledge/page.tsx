import type { Metadata } from "next";
import { AdminKnowledgePage } from "@/components/admin-knowledge-page";

export const metadata: Metadata = {
  title: "Knowledge Base — Admin",
  description: "Deep Dive Brewing Co internal knowledge base.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminKnowledgeRoute() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <AdminKnowledgePage />
    </main>
  );
}
