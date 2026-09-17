import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { beerImageUrl } from "../../lib/utils";

const readSource = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("beerImageUrl", () => {
  it("builds a Firebase Storage download URL for a beer image path", () => {
    const url = beerImageUrl("beers/pale-lager/card.jpg");
    assert.match(
      url,
      /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/.+\/o\/beers%2Fpale-lager%2Fcard\.jpg\?alt=media$/
    );
  });
});

describe("Firebase-free public image helpers", () => {
  it("keeps lib/utils.ts free of Firebase SDK imports", () => {
    const source = readSource("lib/utils.ts");
    assert.equal(
      /from\s+["']firebase\//.test(source) ||
        /from\s+["']@\/lib\/firebase["']/.test(source),
      false,
      "lib/utils.ts must stay Firebase-free: it is imported by client " +
        "components (e.g. BeerCard), so a Firebase import would ship the " +
        "client SDK to every public page."
    );
  });

  it("beer-card does not import lib/beers (which pulls in firebase/firestore)", () => {
    const source = readSource("components/beer-card.tsx");
    assert.equal(
      /from\s+["']@\/lib\/beers["']/.test(source),
      false,
      "BeerCard is rendered inside client components; importing lib/beers " +
        "ships the Firebase client bundle to public routes."
    );
  });
});

describe("hero video poster loading", () => {
  it("does not use a <video poster> attribute (it bypasses viewport gating)", () => {
    const source = readSource("components/hero-video.tsx");
    assert.equal(
      /\bposter=/.test(source),
      false,
      "A poster attribute on the SSR'd <video> fetches the raw image at " +
        "HTML parse time, duplicating the optimized poster download. The " +
        "poster is rendered via next/image underneath the video instead."
    );
  });
});
