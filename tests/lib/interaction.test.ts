import { describe, it } from "node:test";
import assert from "node:assert";
import { pressableClasses } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

// UX polish — the shared pressed-state primitive. These tests pin the
// contract of pressableClasses and buttonVariants: every interactive
// control gets a visible press acknowledgement, reduced-motion sessions
// are never transformed, and disabled controls lose interactive feedback
// entirely. They assert class contracts, not animation timing.

describe("pressableClasses", () => {
  it("carries a transition so state changes are visible", () => {
    assert.match(pressableClasses, /transition/);
    assert.match(pressableClasses, /duration-/);
  });

  it("scales down on :active but only when motion is allowed", () => {
    assert.match(pressableClasses, /motion-safe:active:scale-/);
    // The transform must never leak into prefers-reduced-motion sessions —
    // it is gated by motion-safe, not merely overridden.
    assert.doesNotMatch(pressableClasses, /motion-reduce:active:scale/);
  });
});

describe("buttonVariants press feedback", () => {
  it("gives button-style variants a pressed scale", () => {
    for (const variant of [
      "default",
      "destructive",
      "outline",
      "secondary",
      "ghost",
    ] as const) {
      assert.match(
        buttonVariants({ variant }),
        /motion-safe:active:scale-/,
        `expected press feedback on variant "${variant}"`
      );
    }
  });

  it("does not scale the text-only link variant", () => {
    const classes = buttonVariants({ variant: "link" });
    assert.doesNotMatch(classes, /scale-/);
  });

  it("disabled controls lose interactive feedback and read as muted", () => {
    const classes = buttonVariants({});
    // pointer-events-none strips hover/press visuals entirely, and the
    // opacity + desaturation read clearly as "off" rather than merely a
    // slightly different gray.
    assert.match(classes, /disabled:pointer-events-none/);
    assert.match(classes, /disabled:opacity-/);
    assert.match(classes, /disabled:saturate-/);
  });

  it("keeps a visible focus indicator on every variant", () => {
    for (const variant of [
      "default",
      "destructive",
      "outline",
      "secondary",
      "ghost",
      "link",
    ] as const) {
      assert.match(
        buttonVariants({ variant }),
        /focus-visible:ring-/,
        `expected focus-visible styling on variant "${variant}"`
      );
    }
  });
});
