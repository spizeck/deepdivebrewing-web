import { SiteHeaderDefault } from "@/components/site-header-default";

export default function PagesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeaderDefault />
      <div className="min-h-screen pt-15">{children}</div>
    </>
  );
}
