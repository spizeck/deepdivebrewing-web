import Link from "next/link";
import Image from "next/image";
import { formatUpdateDate, type Update } from "@/lib/updates";

/**
 * Editorial archive for /updates (Issue #194): the newest update leads as
 * a feature with its hero image, and older updates follow as a dated
 * reading list — not a card grid. Shared by the real archive page and the
 * env-gated /updates-fixture route so the smoke suite exercises the same
 * rendering for empty, single, and multi-post states.
 */
export function UpdatesArchive({
  updates,
  basePath = "/updates",
}: {
  updates: Update[];
  /** Link target prefix — the fixture route points entries at its own
   *  stub detail pages so archive links never hit real (404) routes. */
  basePath?: string;
}) {
  if (updates.length === 0) {
    return (
      <section className="rounded-lg border border-stone bg-stone/20 p-6 md:p-8">
        <h2 className="text-xl font-semibold text-ink">
          Nothing new to report — yet
        </h2>
        <p className="mt-2 max-w-180 text-muted-foreground">
          Check back soon for beer releases, new places to find a pour, and
          stories from the brewhouse at Fort Bay.
        </p>
        <Link
          href="/beers"
          className="mt-4 inline-flex min-h-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
        >
          Explore our beers &rarr;
        </Link>
      </section>
    );
  }

  const [featured, ...rest] = updates;

  return (
    <>
      <article>
        {featured.image && (
          <Link
            href={`${basePath}/${featured.slug}`}
            tabIndex={-1}
            aria-hidden="true"
            className="block"
          >
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-stone/40">
              <Image
                src={featured.image.src}
                alt={featured.image.alt}
                fill
                priority
                quality={80}
                sizes="(max-width: 1152px) 100vw, 1152px"
                className="object-cover"
              />
            </div>
          </Link>
        )}
        <div className="mt-6 max-w-180">
          <p className="text-sm font-medium text-ocean">
            <time dateTime={featured.publishedAt}>
              {formatUpdateDate(featured.publishedAt)}
            </time>
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">
            <Link
              href={`${basePath}/${featured.slug}`}
              className="transition-opacity duration-200 hover:opacity-85"
            >
              {featured.title}
            </Link>
          </h2>
          <p className="mt-3 text-muted-foreground">{featured.summary}</p>
          <Link
            href={`${basePath}/${featured.slug}`}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
          >
            Read the update &rarr;
          </Link>
        </div>
      </article>

      {rest.length > 0 && (
        <ol className="mt-16 divide-y divide-stone border-t border-stone">
          {rest.map((update) => (
            <li key={update.slug} className="py-8 md:flex md:gap-10">
              <p className="shrink-0 text-sm font-medium text-ocean md:w-40 md:pt-1">
                <time dateTime={update.publishedAt}>
                  {formatUpdateDate(update.publishedAt)}
                </time>
              </p>
              <div className="mt-2 max-w-180 md:mt-0">
                <h3 className="text-xl font-semibold tracking-tight">
                  <Link
                    href={`${basePath}/${update.slug}`}
                    className="transition-opacity duration-200 hover:opacity-85"
                  >
                    {update.title}
                  </Link>
                </h3>
                <p className="mt-2 text-muted-foreground">{update.summary}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
