import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isVenueIsland,
  VENUE_ISLAND_CARD_LABELS,
  VENUE_ISLAND_KEYS,
  VENUE_ISLAND_LABELS,
  VENUE_ISLAND_OPTIONS,
} from "../../lib/venue-islands";

describe("venue island vocabulary (Issue #134)", () => {
  it("exposes exactly the supported canonical keys", () => {
    assert.deepEqual([...VENUE_ISLAND_KEYS], ["saba", "sxm", "statia"]);
  });

  it("validates canonical keys and rejects anything else", () => {
    for (const key of VENUE_ISLAND_KEYS) {
      assert.equal(isVenueIsland(key), true, key);
    }
    for (const bad of [
      "Saba",
      "SXM",
      "Philipsburg",
      "Windwardside",
      "bonaire",
      "",
      "constructor",
      0,
      null,
      undefined,
    ]) {
      assert.equal(isVenueIsland(bad), false, String(bad));
    }
  });

  it("maps each key to its whole-island public label", () => {
    assert.equal(VENUE_ISLAND_LABELS.saba, "Saba");
    assert.equal(VENUE_ISLAND_LABELS.sxm, "Sint Maarten / Saint Martin");
    assert.equal(VENUE_ISLAND_LABELS.statia, "Sint Eustatius / Statia");
    // "sxm" is internal-only — it must never surface as a public label.
    for (const label of Object.values(VENUE_ISLAND_LABELS)) {
      assert.equal(label.includes("SXM"), false, label);
    }
  });

  it("uses short jurisdiction labels for card locality composition", () => {
    assert.equal(VENUE_ISLAND_CARD_LABELS.saba, "Saba");
    assert.equal(VENUE_ISLAND_CARD_LABELS.sxm, "Sint Maarten");
    assert.equal(VENUE_ISLAND_CARD_LABELS.statia, "Statia");
  });

  it("provides admin select options keyed by canonical value", () => {
    assert.deepEqual(
      VENUE_ISLAND_OPTIONS.map((o) => [o.value, o.label]),
      [
        ["saba", "Saba"],
        ["sxm", "Sint Maarten / Saint Martin"],
        ["statia", "Sint Eustatius / Statia"],
      ]
    );
  });
});
