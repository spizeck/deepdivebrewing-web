interface MdxLayoutProps {
  children: React.ReactNode;
}

export function MdxLayout({ children }: MdxLayoutProps) {
  return (
    <main className="mx-auto max-w-300 px-6 py-20 md:py-30">
      <article className="prose-dd mx-auto max-w-180">
        {children}
      </article>
    </main>
  );
}
