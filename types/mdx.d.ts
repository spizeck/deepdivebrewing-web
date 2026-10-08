// Types `.mdx` imports so content files can be imported from TypeScript
// (the updates registry lazy-loads bodies with `import("./<slug>.mdx")`).
// Only the default export — the rendered component — is declared; MDX
// files may add their own exports but we type none of them here.
declare module "*.mdx" {
  import type { ComponentType } from "react";
  const MDXContent: ComponentType;
  export default MDXContent;
}
