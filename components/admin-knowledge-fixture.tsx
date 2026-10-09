"use client";

import { useMemo } from "react";
import { KnowledgeLanding } from "@/components/admin-knowledge-page";
import { KnowledgeArticleShell } from "@/components/admin-knowledge-article";
import { KnowledgeEditor } from "@/components/admin-knowledge-editor";
import { KnowledgeHistory } from "@/components/admin-knowledge-history";
import { createFixtureKnowledgeApi } from "@/lib/knowledge-fixture";

// Test-only rendering of the Knowledge Base surfaces (#201) — same gate as
// /admin-fixture (KNOWLEDGE_FIXTURE is set only by the Playwright webServer
// config; normal deployments 404). Uses the in-memory fixture API, so no
// Firebase credentials or network calls are involved.
export function AdminKnowledgeFixture({ view }: { view: string }) {
  const api = useMemo(() => createFixtureKnowledgeApi(), []);

  switch (view) {
    case "article":
      return <KnowledgeArticleShell api={api} slug="example-sop" />;
    case "draft":
      return (
        <KnowledgeArticleShell api={api} slug="example-draft-reference" />
      );
    case "missing":
      return <KnowledgeArticleShell api={api} slug="no-such-article" />;
    case "edit":
      return <KnowledgeEditor api={api} slug="example-sop" />;
    case "new":
      return <KnowledgeEditor api={api} />;
    case "history":
      return <KnowledgeHistory api={api} slug="example-sop" />;
    default:
      return <KnowledgeLanding api={api} />;
  }
}
