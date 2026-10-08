import Link from "next/link";
import { Reveal } from "@/components/reveal";
import { formatUpdateDate, getPublishedUpdates } from "@/lib/updates";

/**
 * Homepage "Latest from the Brewery" teaser (Issue #194) — the newest few
 * published updates as a dated reading list, with a link to the full
 * archive. Renders nothing when no updates are published so the homepage
 * stays clean until the first post ships.
 */
export function UpdatesTeaser() {
  const updates = getPublishedUpdates().slice(0, 3);
  if (updates.length === 0) return null;

  return (
    <Reveal as="section" className="border-t border-stone">
      <div className="mx-auto max-w-300 px-6 py-20 md:py-30">
        <div className="flex items-end justify-between">
          <h2 className="text-3xl font-bold tracking-tight">
            Latest from the Brewery
          </h2>
          <Link
            href="/updates"
            className="inline-flex min-h-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
          >
            All updates &rarr;
          </Link>
        </div>
        <ol className="mt-10 divide-y divide-stone border-t border-stone">
          {updates.map((update) => (
            <li key={update.slug} className="py-6 md:flex md:gap-10">
              <p className="shrink-0 text-sm font-medium text-ocean md:w-40 md:pt-1">
                <time dateTime={update.publishedAt}>
                  {formatUpdateDate(update.publishedAt)}
                </time>
              </p>
              <div className="mt-1 max-w-180 md:mt-0">
                <h3 className="text-xl font-semibold tracking-tight">
                  <Link
                    href={`/updates/${update.slug}`}
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
      </div>
    </Reveal>
  );
}
