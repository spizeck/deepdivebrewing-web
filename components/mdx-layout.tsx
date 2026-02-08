interface MdxLayoutProps {
  children: React.ReactNode;
}

export function MdxLayout({ children }: MdxLayoutProps) {
  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <article className="prose-dd mx-auto max-w-180">
        {children}
      </article>
    </main>
  );
}
