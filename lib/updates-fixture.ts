import type { Update } from "@/lib/updates";

// Deterministic fixture records for the test-only /updates-fixture route
// used by the Playwright smoke suite to exercise the archive's single and
// multi-post layouts (the empty state is just an empty list). Shapes match
// the real Update model so UpdatesArchive exercises the same code path as
// the production page. Not real business data — titles are placeholders.
export const UPDATES_FIXTURE_SINGLE: Update[] = [
  {
    slug: "fixture-single-update",
    title: "Fixture Single Update",
    publishedAt: "2026-06-15",
    summary: "A lone update exercising the feature-lead archive layout.",
  },
];

export const UPDATES_FIXTURE_MANY: Update[] = [
  {
    slug: "fixture-newest-update",
    title: "Fixture Newest Update",
    publishedAt: "2026-08-20",
    summary: "The newest fixture update leads the archive as the feature.",
    image: {
      src: "/photos/og-default.jpg",
      alt: "Fixture hero image",
    },
  },
  {
    slug: "fixture-middle-update",
    title: "Fixture Middle Update",
    publishedAt: "2026-07-04",
    summary: "A middle fixture update listed as a dated archive row.",
  },
  {
    slug: "fixture-oldest-update",
    title: "Fixture Oldest Update",
    publishedAt: "2026-05-01",
    summary: "The oldest fixture update anchors the archive list.",
  },
];
