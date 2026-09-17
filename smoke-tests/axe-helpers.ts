import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright/test";

// Shared axe policy for the smoke suite: serious and critical violations are
// blocking; moderate/minor findings and incomplete checks are printed for
// review without failing. See docs/operations/accessibility.md.

export const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

// Entry animations (fade-ins, delayed reveals) leave elements partially
// transparent during the scan, which produces false color-contrast
// measurements. Wait until every CSS animation/transition has finished
// before analyzing — pages without animations resolve immediately.
export async function waitForAnimations(page: Page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((animation) =>
            ["finished", "idle"].includes(animation.playState)
          ),
      { timeout: 5_000 }
    )
    .catch(() => {
      // A long-running/looping animation is not a blocker — scan anyway.
    });
}

// Returns the list of blocking violations; caller asserts it is empty.
export async function scanAxe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  const blocking = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? "")
  );

  const nonBlocking = [
    ...results.violations.filter(
      (violation) => !BLOCKING_IMPACTS.has(violation.impact ?? "")
    ),
    ...results.incomplete,
  ];
  if (nonBlocking.length > 0) {
    console.log(
      `axe non-blocking findings on ${label}:\n` +
        nonBlocking
          .map(
            (v) =>
              `- ${v.id} (${v.impact ?? "review"}): ${v.nodes.length} node(s)`
          )
          .join("\n")
    );
  }

  return blocking;
}

export function formatBlocking(label: string, blocking: Awaited<ReturnType<typeof scanAxe>>) {
  return `serious/critical axe violations on ${label}:\n${blocking
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n${v.nodes
          .map((n) => `  - ${n.target.join(" ")} :: ${n.failureSummary}`)
          .join("\n")}`
    )
    .join("\n")}`;
}
