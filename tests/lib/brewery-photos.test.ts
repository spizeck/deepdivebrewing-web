import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BREWERY_PHOTOS } from "@/lib/brewery-photos";

// Editorial photography catalog (Issue #193) — invariants that keep a
// stale path from shipping a broken image and keep the captions inside
// the About page's editorial rules.
const PHOTOS_DIR = path.join(process.cwd(), "public", "photos");

describe("brewery photo catalog", () => {
  it("every photo src resolves to a real file under public/photos", () => {
    assert.ok(BREWERY_PHOTOS.length > 0, "catalog is empty");
    for (const photo of BREWERY_PHOTOS) {
      assert.ok(
        photo.src.startsWith("/photos/"),
        `${photo.id}: src must live under /photos`
      );
      assert.ok(
        fs.existsSync(path.join(PHOTOS_DIR, photo.src.replace("/photos/", ""))),
        `${photo.id}: file missing for ${photo.src}`
      );
    }
  });

  it("ids and srcs are unique", () => {
    const ids = BREWERY_PHOTOS.map((p) => p.id);
    const srcs = BREWERY_PHOTOS.map((p) => p.src);
    assert.strictEqual(new Set(ids).size, ids.length, "duplicate photo id");
    assert.strictEqual(new Set(srcs).size, srcs.length, "duplicate photo src");
  });

  it("declared dimensions are positive and plausibly real", () => {
    for (const photo of BREWERY_PHOTOS) {
      assert.ok(photo.width > 0 && photo.height > 0, `${photo.id}: bad dims`);
      // The derivative pipeline caps the long edge at 2048; the one
      // smaller asset (video-still) is a video frame by nature.
      assert.ok(
        Math.max(photo.width, photo.height) >= 720,
        `${photo.id}: implausibly small source`
      );
    }
  });

  it("alt text and captions are non-empty and dash-free", () => {
    for (const photo of BREWERY_PHOTOS) {
      assert.ok(photo.alt.trim().length > 0, `${photo.id}: empty alt`);
      assert.ok(photo.caption.trim().length > 0, `${photo.id}: empty caption`);
      // The /about smoke suite forbids em dashes anywhere in the article.
      assert.ok(
        !photo.caption.includes("—") && !photo.alt.includes("—"),
        `${photo.id}: em dash in caption or alt`
      );
    }
  });
});
