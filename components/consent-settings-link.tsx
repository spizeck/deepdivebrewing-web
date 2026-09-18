"use client";

import { usePathname } from "next/navigation";

/**
 * "Cookie preferences" control that reopens the Klaro consent manager so
 * visitors can change or withdraw their choice at any time. Rendered in
 * the site footer (and reusable elsewhere). Hidden on /admin*, where the
 * consent layer never loads and the handler does not exist.
 */
export function ConsentSettingsLink() {
  const isAdminPath = usePathname()?.startsWith("/admin") === true;
  if (isAdminPath) return null;
  return (
    <li>
      <button
        type="button"
        onClick={() => window.ddbConsentShow?.()}
        className="inline-flex min-h-[44px] cursor-pointer items-center text-sm text-muted-foreground transition-opacity duration-200 hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ink/50"
      >
        Cookie preferences
      </button>
    </li>
  );
}
