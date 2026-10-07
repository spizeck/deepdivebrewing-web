import { SiteNav } from "@/components/site-nav";

export default function PagesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteNav />
      {/* The nav is a fixed floating pill (~72px incl. its top offset and
          any safe-area inset); the padding clears it with the breathing
          room the floating treatment calls for. */}
      <div className="min-h-screen pt-[calc(5.75rem+env(safe-area-inset-top))]">
        {children}
      </div>
    </>
  );
}
