import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeSlug from "rehype-slug";
import {
  Info,
  Lightbulb,
  OctagonAlert,
  StickyNote,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  normalizeKnowledgeMarkdown,
  remarkKnowledgeCallouts,
} from "@/lib/knowledge-markdown";
import {
  KnowledgeStorageImage,
  KnowledgeStorageLink,
} from "@/components/knowledge-attachment";
import type { KnowledgeCalloutType } from "@/lib/knowledge-common";

/**
 * The single renderer for Knowledge Base Markdown (#201). Preview, published
 * view, print view, and history snapshots all render through this component,
 * so what the editor previews is exactly what readers see.
 *
 * Safety: react-markdown does not render raw HTML — authored markup is
 * escaped as text — and `urlTransform` below restricts link/image protocols
 * to a safe allowlist plus the internal `kb:` attachment scheme.
 */

const CALLOUT_ICONS: Record<KnowledgeCalloutType, LucideIcon> = {
  note: StickyNote,
  info: Info,
  tip: Lightbulb,
  warning: TriangleAlert,
  danger: OctagonAlert,
};

function urlTransform(url: string): string {
  // Internal attachment scheme — resolved to authenticated Storage blobs by
  // the link/image components below.
  if (url.startsWith("kb:")) return url;
  return defaultUrlTransform(url);
}

function dataProp(props: object, name: string): string {
  const record = props as Record<string, unknown>;
  const value = record[name];
  return typeof value === "string" ? value : "";
}

const CALLOUT_TYPES = new Set(["note", "info", "tip", "warning", "danger"]);

const components: Components = {
  // `node` is react-markdown's internal hast prop — destructure it away
  // everywhere so it never leaks into DOM attributes.
  aside({ node, children, ...props }) {
    void node;
    const type = dataProp(props, "data-callout");
    if (!CALLOUT_TYPES.has(type)) {
      return <aside {...props}>{children}</aside>;
    }
    const title =
      dataProp(props, "data-callout-title") ||
      type.charAt(0).toUpperCase() + type.slice(1);
    const Icon = CALLOUT_ICONS[type as KnowledgeCalloutType];
    return (
      <aside
        className={cn("kb-callout", `kb-callout-${type}`)}
        aria-label={title}
      >
        <p className="kb-callout-title">
          <Icon aria-hidden="true" className="kb-callout-icon" />
          <span>{title}</span>
        </p>
        <div className="kb-callout-body">{children}</div>
      </aside>
    );
  },
  a({ node, href, children, ...rest }) {
    void node;
    const target = typeof href === "string" ? href : "";
    if (target.startsWith("kb:")) {
      return (
        <KnowledgeStorageLink path={target.slice(3)}>
          {children}
        </KnowledgeStorageLink>
      );
    }
    if (target.startsWith("/")) {
      return (
        <Link href={target} {...rest}>
          {children}
        </Link>
      );
    }
    return (
      <a href={target} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  img({ node, src, alt, ...rest }) {
    void node;
    const source = typeof src === "string" ? src : "";
    const label = typeof alt === "string" ? alt : "";
    if (source.startsWith("kb:")) {
      return <KnowledgeStorageImage path={source.slice(3)} alt={label} />;
    }
    // Article images can be same-site paths or runtime blob: object URLs —
    // next/image adds no value here.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={source} alt={label} loading="lazy" {...rest} />
    );
  },
  li({ node, className, children, ...rest }) {
    void node;
    // GFM task-list items render a disabled checkbox before the text. Wrap
    // them in a label so the input has an implicit accessible name.
    if (typeof className === "string" && className.includes("task-list-item")) {
      return (
        <li className={className} {...rest}>
          <label className="kb-task-label">{children}</label>
        </li>
      );
    }
    return (
      <li className={className} {...rest}>
        {children}
      </li>
    );
  },
  table({ node, children, ...rest }) {
    void node;
    return (
      <div className="kb-table-scroll">
        <table {...rest}>{children}</table>
      </div>
    );
  },
};

export function KnowledgeArticleBody({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div className={cn("kb-prose", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, remarkKnowledgeCallouts]}
        rehypePlugins={[rehypeSlug]}
        urlTransform={urlTransform}
        components={components}
      >
        {normalizeKnowledgeMarkdown(markdown)}
      </ReactMarkdown>
    </div>
  );
}
