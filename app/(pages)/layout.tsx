import { SiteNav } from "@/components/site-nav";

export default function PagesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteNav />
      {/* The nav is a fixed floating pill (~72px incl. its top offset);
          pt-24 clears it with the breathing room the floating treatment
          calls for. */}
      <div className="min-h-screen pt-24">{children}</div>
    </>
  );
}
