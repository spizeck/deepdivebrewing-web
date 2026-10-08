import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  formatUpdateDate,
  getPublishedUpdates,
  getUpdateBySlug,
} from "@/lib/updates";
import { buildUpdateJsonLd } from "@/lib/update-json-ld";
import { serializeJsonLd } from "@/lib/json-ld";

// Update detail pages are statically generated for the slugs known at
// build time; a new update becomes reachable after the normal deploy.
// Unknown slugs are never rendered on demand — they 404.
export const dynamicParams = false;

// Drafts are included so a `draft: true` entry is previewable under
// `next dev`; in production builds they render as the 404 below.
export function generateStaticParams() {
  return getPublishedUpdates({ includeDrafts: true }).map((update) => ({
    slug: update.slug,
  }));
}

interface UpdatePageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: UpdatePageProps): Promise<Metadata> {
  const { slug } = await params;
  const update = getUpdateBySlug(slug);
  if (!update) {
    return {
      title: "Update Not Found",
      robots: { index: false },
    };
  }

  const image = update.image?.src ?? "/photos/og-default.jpg";

  return {
    title: update.title,
    description: update.summary,
    alternates: {
      canonical: `/updates/${update.slug}`,
    },
    openGraph: {
      title: `${update.title} | Deep Dive Brewing Co`,
      description: update.summary,
      type: "article",
      url: `/updates/${update.slug}`,
      publishedTime: update.publishedAt,
      images: [{ url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${update.title} | Deep Dive Brewing Co`,
      description: update.summary,
      images: [image],
    },
  };
}

export default async function UpdatePage({ params }: UpdatePageProps) {
  const { slug } = await params;
  const update = getUpdateBySlug(slug);
  if (!update) notFound();

  const { default: Body } = await update.loadBody();

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-300 px-6 pb-20 md:pb-30"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildUpdateJsonLd(update)) }}
      />
      <nav
        aria-label="Breadcrumb"
        className="mb-8 text-sm text-muted-foreground"
      >
        <Link
          href="/updates"
          className="transition-opacity duration-200 hover:opacity-85"
        >
          Updates
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink">{update.title}</span>
      </nav>

      <article className="mx-auto max-w-180">
        <header>
          <p className="text-sm font-medium text-ocean">
            <time dateTime={update.publishedAt}>
              {formatUpdateDate(update.publishedAt)}
            </time>
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">
            {update.title}
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">
            {update.summary}
          </p>
        </header>

        {update.image && (
          <figure className="mt-8">
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-stone/40">
              <Image
                src={update.image.src}
                alt={update.image.alt}
                fill
                priority
                quality={80}
                sizes="(max-width: 720px) 100vw, 720px"
                className="object-cover"
              />
            </div>
            {update.image.caption && (
              <figcaption className="mt-2 text-sm text-muted-foreground">
                {update.image.caption}
              </figcaption>
            )}
          </figure>
        )}

        <div className="prose-dd mt-8">
          <Body />
        </div>

        <footer className="mt-10 border-t border-stone pt-6">
          <div className="flex flex-wrap items-center gap-4">
            {update.cta && (
              <Button asChild className="h-11 min-h-[44px] px-6">
                <Link href={update.cta.href}>{update.cta.label}</Link>
              </Button>
            )}
            <Link
              href="/updates"
              className="inline-flex min-h-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              &larr; All updates
            </Link>
          </div>
        </footer>
      </article>
    </main>
  );
}
