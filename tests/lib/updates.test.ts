import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync } from "node:fs";
import path from "node:path";
import { updateEntries } from "../../content/updates";
import {
  filterPublishedUpdates,
  formatUpdateDate,
  getPublishedUpdates,
  getUpdateBySlug,
  validateUpdateEntries,
  type Update,
} from "../../lib/updates";
import { buildUpdateJsonLd } from "../../lib/update-json-ld";
import { serializeJsonLd } from "../../lib/json-ld";

function validUpdate(overrides: Partial<Update> = {}): Update {
  return {
    slug: "a-real-update",
    title: "A Real Update",
    publishedAt: "2026-10-01",
    summary: "A short summary of the update.",
    ...overrides,
  };
}

describe("validateUpdateEntries", () => {
  it("accepts a well-formed entry", () => {
    assert.deepEqual(validateUpdateEntries([validUpdate()]), []);
  });

  it("rejects malformed slugs and duplicate slugs", () => {
    const problems = validateUpdateEntries([
      validUpdate({ slug: "Not A Slug!" }),
      validUpdate({ slug: "dup" }),
      validUpdate({ slug: "dup" }),
    ]);
    assert.ok(problems.some((p) => p.includes("lowercase words")));
    assert.ok(problems.some((p) => p.includes("duplicate slug")));
  });

  it("rejects missing titles, bad dates, and over-long summaries", () => {
    const problems = validateUpdateEntries([
      validUpdate({ title: "  " }),
      validUpdate({ slug: "bad-date", publishedAt: "October 6, 2026" }),
      validUpdate({ slug: "not-a-date", publishedAt: "2026-13-99" }),
      validUpdate({ slug: "long", summary: "x".repeat(221) }),
    ]);
    assert.ok(problems.some((p) => p.includes("title is required")));
    assert.equal(
      problems.filter((p) => p.includes("YYYY-MM-DD")).length,
      2
    );
    assert.ok(problems.some((p) => p.includes("220 characters")));
  });

  it("requires image alt text and complete CTAs", () => {
    const problems = validateUpdateEntries([
      validUpdate({
        slug: "no-alt",
        image: { src: "/photos/x.jpg", alt: "  " },
      }),
      validUpdate({ slug: "bad-cta", cta: { label: "", href: "" } }),
    ]);
    assert.ok(problems.some((p) => p.includes("image.alt")));
    assert.ok(problems.some((p) => p.includes("cta")));
  });

  it("rejects impossible dates that Date.parse rolls over", () => {
    const problems = validateUpdateEntries([
      validUpdate({ slug: "overflow", publishedAt: "2026-02-30" }),
      validUpdate({ slug: "edge", publishedAt: "2024-02-29" }),
    ]);
    assert.ok(problems.some((p) => p.includes('"overflow"')));
    assert.ok(!problems.some((p) => p.includes('"edge"')));
  });

  it("restricts image src to local paths and Firebase Storage", () => {
    const problems = validateUpdateEntries([
      validUpdate({
        slug: "remote-img",
        image: { src: "https://cdn.example.com/x.jpg", alt: "x" },
      }),
      validUpdate({
        slug: "http-img",
        image: { src: "http://firebasestorage.googleapis.com/x", alt: "x" },
      }),
      validUpdate({
        slug: "protocol-rel-img",
        image: { src: "//cdn.example.com/x.jpg", alt: "x" },
      }),
      validUpdate({
        slug: "storage-img",
        image: {
          src: "https://firebasestorage.googleapis.com/v0/b/x/o/y.jpg",
          alt: "y",
        },
      }),
      validUpdate({
        slug: "local-img",
        image: { src: "/photos/x.jpg", alt: "x" },
      }),
    ]);
    assert.ok(problems.some((p) => p.includes('"remote-img"')));
    assert.ok(problems.some((p) => p.includes('"http-img"')));
    assert.ok(problems.some((p) => p.includes('"protocol-rel-img"')));
    assert.ok(!problems.some((p) => p.includes('"storage-img"')));
    assert.ok(!problems.some((p) => p.includes('"local-img"')));
  });

  it("requires CTA hrefs to be local paths or absolute https URLs", () => {
    const problems = validateUpdateEntries([
      validUpdate({
        slug: "relative-cta",
        cta: { label: "Go", href: "where-to-buy" },
      }),
      validUpdate({
        slug: "protocol-rel-cta",
        cta: { label: "Go", href: "//example.com/x" },
      }),
      validUpdate({
        slug: "js-cta",
        cta: { label: "Go", href: "javascript:alert(1)" },
      }),
      validUpdate({
        slug: "local-cta",
        cta: { label: "Go", href: "/where-to-buy" },
      }),
      validUpdate({
        slug: "https-cta",
        cta: { label: "Go", href: "https://example.com/x" },
      }),
    ]);
    assert.ok(problems.some((p) => p.includes('"relative-cta"')));
    assert.ok(problems.some((p) => p.includes('"protocol-rel-cta"')));
    assert.ok(problems.some((p) => p.includes('"js-cta"')));
    assert.ok(!problems.some((p) => p.includes('"local-cta"')));
    assert.ok(!problems.some((p) => p.includes('"https-cta"')));
  });
});

describe("filterPublishedUpdates", () => {
  const entries: Update[] = [
    validUpdate({ slug: "oldest", publishedAt: "2026-01-01" }),
    validUpdate({ slug: "newest", publishedAt: "2026-10-01" }),
    validUpdate({ slug: "draft-post", publishedAt: "2026-12-01", draft: true }),
    validUpdate({ slug: "middle", publishedAt: "2026-05-01" }),
  ];

  it("sorts published entries newest first and excludes drafts", () => {
    const slugs = filterPublishedUpdates(entries).map((e) => e.slug);
    assert.deepEqual(slugs, ["newest", "middle", "oldest"]);
  });

  it("includes drafts only when asked", () => {
    const slugs = filterPublishedUpdates(entries, {
      includeDrafts: true,
    }).map((e) => e.slug);
    assert.deepEqual(slugs, ["draft-post", "newest", "middle", "oldest"]);
  });
});

describe("updates registry", () => {
  it("contains only valid entries", () => {
    assert.deepEqual(
      validateUpdateEntries(updateEntries),
      [],
      "content/updates/index.ts must not contain invalid entries"
    );
  });

  it("keeps registry entries and .mdx body files in sync by slug", () => {
    const dir = path.join(process.cwd(), "content", "updates");
    const files = new Set(
      readdirSync(dir).filter((file) => file.endsWith(".mdx"))
    );
    for (const entry of updateEntries) {
      assert.ok(
        files.has(`${entry.slug}.mdx`),
        `missing body file content/updates/${entry.slug}.mdx`
      );
      files.delete(`${entry.slug}.mdx`);
    }
    assert.deepEqual(
      [...files],
      [],
      "unregistered .mdx files in content/updates — add them to index.ts"
    );
  });
});

describe("getUpdateBySlug", () => {
  it("returns the seeded update for a known slug", () => {
    const update = getUpdateBySlug("brew-day-at-fort-bay");
    assert.ok(update);
    assert.equal(update.slug, "brew-day-at-fort-bay");
  });

  it("returns null for an unknown slug", () => {
    assert.equal(getUpdateBySlug("definitely-not-real"), null);
  });
});

describe("getPublishedUpdates", () => {
  it("returns the seeded registry newest-first", () => {
    const updates = getPublishedUpdates();
    assert.ok(updates.length >= 1);
    for (const update of updates) {
      assert.ok(!update.draft);
    }
  });
});

describe("formatUpdateDate", () => {
  it("formats ISO dates for display without timezone drift", () => {
    assert.equal(formatUpdateDate("2026-10-06"), "October 6, 2026");
    assert.equal(formatUpdateDate("2025-01-31"), "January 31, 2025");
  });
});

describe("buildUpdateJsonLd", () => {
  const update = validUpdate({
    slug: "brew-day-at-fort-bay",
    title: "Brew Day at Fort Bay",
    image: { src: "/photos/herograin.jpg", alt: "Milled malt" },
  });
  const jsonLd = buildUpdateJsonLd(update);

  it("emits an accurate BlogPosting node", () => {
    assert.equal(jsonLd["@type"], "BlogPosting");
    assert.equal(jsonLd.headline, "Brew Day at Fort Bay");
    assert.equal(jsonLd.datePublished, "2026-10-01");
    assert.equal(
      jsonLd.mainEntityOfPage,
      "https://deepdivebrewing.com/updates/brew-day-at-fort-bay"
    );
    assert.equal(
      jsonLd.author["@id"],
      "https://deepdivebrewing.com/#brewery"
    );
    assert.equal(jsonLd.publisher["@type"], "Brewery");
  });

  it("resolves site-relative hero images to absolute URLs", () => {
    assert.equal(
      jsonLd.image,
      "https://deepdivebrewing.com/photos/herograin.jpg"
    );
    const absolute = buildUpdateJsonLd(
      validUpdate({ image: { src: "https://example.com/x.jpg", alt: "x" } })
    );
    assert.equal(absolute.image, "https://example.com/x.jpg");
    const none = buildUpdateJsonLd(validUpdate());
    assert.equal("image" in none, false);
  });

  it("serializes safely for inline script tags", () => {
    const serialized = serializeJsonLd(
      buildUpdateJsonLd(
        validUpdate({ title: 'A "</script>" breakout attempt' })
      )
    );
    assert.ok(!serialized.includes("</script>"));
  });
});

describe("sitemap", () => {
  it("includes the archive and published updates with real lastmod dates", async () => {
    const { default: sitemap } = await import("../../app/sitemap");
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    assert.ok(urls.includes("https://deepdivebrewing.com/updates"));
    for (const update of getPublishedUpdates()) {
      const route = entries.find(
        (e) => e.url === `https://deepdivebrewing.com/updates/${update.slug}`
      );
      assert.ok(route, `sitemap missing /updates/${update.slug}`);
      assert.ok(route.lastModified, "update sitemap entry needs lastModified");
    }
    assert.ok(
      !urls.some((u) => u.includes("fixture") || u.includes("/admin")),
      "sitemap must not contain private or fixture routes"
    );
  });
});
