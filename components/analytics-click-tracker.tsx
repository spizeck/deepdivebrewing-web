"use client";

import { useEffect } from "react";
import { trackEvent, type AnalyticsEventName } from "@/lib/analytics";

const PARAM_KEYS = [
  "eventCategory",
  "eventLabel",
  "beerSlug",
  "beerName",
  "beerStyle",
  "partnerName",
  "island",
  "ctaLocation",
  "venueType",
] as const;

function toSnakeCase(input: string): string {
  return input.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function AnalyticsClickTracker() {
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const trigger = target.closest<HTMLElement>("[data-analytics-event]");
      if (!trigger) return;

      const eventName = trigger.dataset.analyticsEvent as AnalyticsEventName | undefined;
      if (!eventName) return;

      const params: Record<string, string | number | undefined> = {};
      for (const key of PARAM_KEYS) {
        const value = trigger.dataset[`analytics${key.charAt(0).toUpperCase() + key.slice(1)}`];
        if (value !== undefined) {
          params[toSnakeCase(key)] = value;
        }
      }

      trackEvent(eventName, params);
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return null;
}
