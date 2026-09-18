"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
  buildKlaroConfig,
  CONSENT_SERVICES,
  consentUpdateFromStates,
  pushConsentUpdate,
  type ConsentService,
} from "@/lib/consent";

/**
 * Self-hosted consent layer: bundled Klaro UI/state → Consent Mode v2
 * updates → GTM → GA4. Klaro is loaded lazily in the browser only (its
 * UMD bundle touches `self`, so it can never be evaluated during SSR),
 * mounts inside the `klaro` div rendered here, and disappears with it on
 * /admin* — where this whole component returns null and never loads.
 *
 * Klaro governs consent state only; it never touches event semantics.
 * Updates are pushed when the visitor saves a choice, plus once on load
 * when a stored choice already exists (restoring granted consent before
 * GTM's tags would otherwise keep running under the denied default).
 */

interface KlaroManager {
  confirmed: boolean;
  getConsent(serviceName: string): boolean;
  watch(watcher: { update(manager: unknown, event: string): void }): void;
}

interface KlaroModule {
  setup(config: unknown): void;
  show(config?: unknown, modal?: boolean): void;
  getManager(config?: unknown): KlaroManager;
}

declare global {
  interface Window {
    ddbConsentShow?: () => void;
  }
}

const CONSENT_MANAGED_SERVICES: ConsentService[] = CONSENT_SERVICES.filter(
  (s) => s.consentManaged !== false
);

export function ConsentManager() {
  const isAdminPath = usePathname()?.startsWith("/admin") === true;

  useEffect(() => {
    if (isAdminPath) return;
    const config = buildKlaroConfig();
    let cancelled = false;
    let klaroPromise: Promise<KlaroModule> | undefined;
    const loadKlaro = () =>
      (klaroPromise ??= import("klaro") as unknown as Promise<KlaroModule>);

    // Available immediately: a click before the lazy chunk resolves still
    // opens the manager once it arrives, never a dead control.
    window.ddbConsentShow = () => {
      void loadKlaro()
        .then((klaro) => klaro.show(config))
        .catch(() => {});
    };

    void (async () => {
      try {
        const klaro = await loadKlaro();
        if (cancelled) return;
        klaro.setup(config);
        const manager = klaro.getManager(config);
        const publish = () => {
          const states: Record<string, boolean> = {};
          for (const service of CONSENT_MANAGED_SERVICES) {
            states[service.name] = manager.getConsent(service.name);
          }
          pushConsentUpdate(consentUpdateFromStates(states));
        };
        manager.watch({
          update: (_mgr, event) => {
            // Publish only on committed choices — not while the visitor is
            // still toggling inside the modal.
            if (event === "saveConsents") publish();
          },
        });
        if (manager.confirmed) publish();
      } catch {
        // If the consent layer fails to initialize, the site must keep
        // working; Consent Mode defaults remain denied.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdminPath]);

  if (isAdminPath) return null;
  return <div id="klaro" />;
}
