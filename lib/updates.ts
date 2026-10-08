import type { ComponentType } from "react";
import { updateEntries } from "@/content/updates";

/**
 * Brewery Updates — the content layer for `/updates` (Issue #194).
 *
 * Updates are repository-authored: each entry is a typed record in
 * `content/updates/index.ts` whose body lives in a sibling `.mdx` file,
 * statically compiled by `@next/mdx`. There is no database or CMS —
 * publishing an update is a commit, and every page reads the same
 * in-repo registry at build time.
 *
 * This module is deliberately Firebase-free so any server component (and
 * the sitemap) can import it, and so `next build` evaluates it with no
 * environment configuration — matching the credential-free CI contract.
 */

export interface UpdateImage {
  /** Local `/photos/…` path or Firebase Storage URL — the only remote
   *  host `next/image` is configured to optimize. */
  src: string;
  /** Meaningful alternative text — required whenever an image is set. */
  alt: string;
  /** Optional caption rendered beneath the hero image. */
  caption?: string;
}

export interface UpdateCta {
  label: string;
  /** Local `/path` or absolute `https://` URL. */
  href: string;
}

/** The authored metadata for one update — everything a listing needs. */
export interface Update {
  /** URL segment under /updates — lowercase words joined by hyphens. */
  slug: string;
  title: string;
  /** ISO date `YYYY-MM-DD` — publish date shown to readers and crawlers. */
  publishedAt: string;
  /** One or two sentences used on the archive, metadata, and previews. */
  summary: string;
  image?: UpdateImage;
  cta?: UpdateCta;
  /**
   * Drafts stay out of the archive, sitemap, and production detail pages
   * but remain previewable under `next dev` (development builds treat
   * `includeDrafts` as on).
   */
  draft?: boolean;
}

/** A registry entry: authored metadata plus a lazy loader for the body. */
export interface UpdateEntry extends Update {
  loadBody: () => Promise<{ default: ComponentType }>;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Summaries double as meta descriptions and card excerpts — long enough to
// say something real, short enough to stay a snippet.
const SUMMARY_MAX_LENGTH = 220;

/** Shape plus a real calendar day — `Date.parse` alone rolls `2026-02-30`
 *  over to March 2 instead of rejecting it, so round-trip the value. */
function isValidPublishDate(isoDate: string): boolean {
  if (!DATE_PATTERN.test(isoDate)) return false;
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === isoDate
  );
}

/** `next/image` only optimizes local paths and Firebase Storage — mirror
 *  `images.remotePatterns` in next.config so a bad image fails the build
 *  with a clear message instead of breaking at render time. */
function isValidImageSrc(src: string): boolean {
  if (src.startsWith("/")) return !src.startsWith("//");
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      url.hostname === "firebasestorage.googleapis.com"
    );
  } catch {
    return false;
  }
}

/** CTAs take readers somewhere predictable: a local `/path` or an absolute
 *  https URL — bare relative paths would resolve against the update URL. */
function isValidCtaHref(href: string): boolean {
  if (href.startsWith("/")) return !href.startsWith("//");
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

/** Semantic checks the type system cannot express. Returns every problem
 *  found, so one build/test run reports all of them. */
export function validateUpdateEntries(
  entries: readonly Update[]
): string[] {
  const problems: string[] = [];
  const seenSlugs = new Set<string>();

  for (const entry of entries) {
    const label = entry.slug || JSON.stringify(entry.title);
    if (!SLUG_PATTERN.test(entry.slug)) {
      problems.push(
        `update "${label}": slug must be lowercase words joined by hyphens`
      );
    }
    if (seenSlugs.has(entry.slug)) {
      problems.push(`update "${label}": duplicate slug`);
    }
    seenSlugs.add(entry.slug);

    if (!entry.title.trim()) {
      problems.push(`update "${label}": title is required`);
    }
    if (!isValidPublishDate(entry.publishedAt)) {
      problems.push(
        `update "${label}": publishedAt must be a real YYYY-MM-DD date`
      );
    }
    if (!entry.summary.trim()) {
      problems.push(`update "${label}": summary is required`);
    } else if (entry.summary.length > SUMMARY_MAX_LENGTH) {
      problems.push(
        `update "${label}": summary must be ${SUMMARY_MAX_LENGTH} characters or fewer`
      );
    }
    if (entry.image) {
      if (!isValidImageSrc(entry.image.src)) {
        problems.push(
          `update "${label}": image.src must be a local /path or firebasestorage.googleapis.com URL`
        );
      }
      if (!entry.image.alt.trim()) {
        problems.push(`update "${label}": image.alt is required`);
      }
    }
    if (entry.cta) {
      if (!entry.cta.label.trim()) {
        problems.push(`update "${label}": cta needs a label`);
      }
      if (!isValidCtaHref(entry.cta.href)) {
        problems.push(
          `update "${label}": cta.href must be a local /path or absolute https URL`
        );
      }
    }
  }
  return problems;
}

function assertValidEntries() {
  const problems = validateUpdateEntries(updateEntries);
  if (problems.length > 0) {
    throw new Error(
      `Invalid updates in content/updates/index.ts:\n- ${problems.join("\n- ")}`
    );
  }
}

/**
 * Filter drafts and sort newest-first (publish date desc, slug asc as a
 * deterministic tie-break). Exported separately from `getPublishedUpdates`
 * so tests can exercise the rule on synthetic entries.
 */
export function filterPublishedUpdates<T extends Update>(
  entries: readonly T[],
  { includeDrafts }: { includeDrafts?: boolean } = {}
): T[] {
  return entries
    .filter((entry) => includeDrafts || !entry.draft)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        a.slug.localeCompare(b.slug)
    );
}

/**
 * Published updates, newest first. Development builds include drafts so a
 * work in progress is previewable with `next dev`; tests can pass
 * `includeDrafts` explicitly. Invalid registry data throws — a broken
 * entry fails the build rather than shipping a malformed page.
 */
export function getPublishedUpdates(
  { includeDrafts }: { includeDrafts?: boolean } = {}
): UpdateEntry[] {
  assertValidEntries();
  const includeAll = includeDrafts ?? process.env.NODE_ENV === "development";
  return filterPublishedUpdates(updateEntries, { includeDrafts: includeAll });
}

/** One published update by slug, or `null` (callers turn it into a 404). */
export function getUpdateBySlug(
  slug: string,
  options?: { includeDrafts?: boolean }
): UpdateEntry | null {
  return getPublishedUpdates(options).find((entry) => entry.slug === slug) ?? null;
}

/** `2026-10-06` → `October 6, 2026` (UTC-anchored — no timezone drift). */
export function formatUpdateDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
