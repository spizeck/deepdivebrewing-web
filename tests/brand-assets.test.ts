import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// Brand-asset wiring checks (hoppy turtle brand system): every icon path
// referenced by metadata/manifest/code must resolve to a real file under
// public/ — a stale reference ships a broken favicon or a broken email logo.
const PUBLIC_DIR = path.join(process.cwd(), "public");

function publicExists(urlPath: string): boolean {
  return fs.existsSync(path.join(PUBLIC_DIR, urlPath.replace(/^\//, "")));
}

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("favicon + app icon wiring", () => {
  const layoutSource = readRepoFile(path.join("app", "layout.tsx"));

  it("every icon URL in layout metadata exists under public/", () => {
    const urls = [...layoutSource.matchAll(/url: "(\/[^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.ok(urls.length > 0, "expected icon entries in layout.tsx");
    for (const url of urls) {
      assert.ok(publicExists(url), `icon file missing: ${url}`);
    }
  });

  it("wires the SVG badge plus light/dark PNG fallbacks", () => {
    assert.ok(layoutSource.includes('"/favicon.svg"'));
    for (const file of [
      "/favicon-16x16.png",
      "/favicon-16x16-dark.png",
      "/favicon-32x32.png",
      "/favicon-32x32-dark.png",
      "/favicon-48x48.png",
      "/favicon.ico",
      "/apple-touch-icon.png",
    ]) {
      assert.ok(
        layoutSource.includes(`"${file}"`),
        `layout.tsx does not reference ${file}`
      );
    }
    assert.ok(
      layoutSource.includes("(prefers-color-scheme: dark)"),
      "dark-scheme icon media hints missing"
    );
  });

  it("manifest icons exist and declare PNG type + a purpose", () => {
    const manifest = JSON.parse(readRepoFile("public/site.webmanifest"));
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
    const sizes = new Set<string>();
    for (const icon of manifest.icons) {
      assert.ok(
        publicExists(icon.src),
        `manifest icon missing: ${icon.src}`
      );
      assert.strictEqual(icon.type, "image/png");
      assert.ok(icon.purpose, `manifest icon ${icon.src} lacks a purpose`);
      sizes.add(icon.sizes);
    }
    assert.ok(sizes.has("192x192") && sizes.has("512x512"));
  });
});

describe("brand mark assets", () => {
  it("ships the monochrome mark set used by UI and email", () => {
    for (const file of [
      "/brand/email-mark-black.png",
      "/brand/email-mark-white.png",
      "/brand/avatar-transparent-black-512.png",
      "/brand/avatar-light-512.png",
      "/brand/avatar-dark-512.png",
      "/brand/hoppy-turtle-black-1600.png",
      "/brand/hoppy-turtle-white-1600.png",
    ]) {
      assert.ok(publicExists(file), `brand asset missing: ${file}`);
    }
  });

  it("every /brand/* path referenced in code resolves to a real file", () => {
    const sources = [
      readRepoFile(path.join("components", "brand-mark.tsx")),
      readRepoFile(path.join("components", "admin-trade-workspace.tsx")),
      readRepoFile(path.join("lib", "trade-leads-email-common.ts")),
    ].join("\n");
    const urls = new Set(
      [...sources.matchAll(/(\/brand\/[\w.-]+\.(?:png|svg|webp|jpg))/g)].map(
        (m) => m[1]
      )
    );
    assert.ok(urls.size > 0, "expected /brand/ references in code");
    for (const url of urls) {
      assert.ok(publicExists(url), `referenced brand asset missing: ${url}`);
    }
  });
});
