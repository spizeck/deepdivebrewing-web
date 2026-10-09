"use client";

import { useEffect, useState } from "react";
import { cn, pressableClasses } from "@/lib/utils";
import type { KnowledgeTocItem } from "@/lib/knowledge-markdown";

/**
 * "On this page" table of contents (#201) — anchored links to the article's
 * rendered h2–h4 (ids applied by rehype-slug, matching the same github-slugger
 * ids extractKnowledgeToc produces). Tracks the visible heading with an
 * IntersectionObserver; purely an enhancement, links work without it.
 */
export function KnowledgeToc({ items }: { items: KnowledgeTocItem[] }) {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    if (items.length === 0) return;
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-15% 0px -70% 0px" }
    );
    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        On this page
      </h2>
      <ul className="mt-2 space-y-1 border-l border-stone">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={activeId === item.id ? "location" : undefined}
              className={cn(
                "block py-1 pr-2 text-sm leading-snug",
                item.depth === 3 && "pl-6",
                item.depth === 4 && "pl-9",
                item.depth === 2 && "pl-3",
                activeId === item.id
                  ? "-ml-px border-l-2 border-ocean font-medium text-ocean"
                  : "text-muted-foreground hover:text-ink",
                pressableClasses
              )}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
