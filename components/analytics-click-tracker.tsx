"use client";

import { useEffect } from "react";
import {
  collectAnalyticsParams,
  trackEvent,
  type AnalyticsEventName,
} from "@/lib/analytics";

export function AnalyticsClickTracker() {
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const trigger = target.closest<HTMLElement>("[data-analytics-event]");
      if (!trigger) return;

      const eventName = trigger.dataset.analyticsEvent as AnalyticsEventName | undefined;
      if (!eventName) return;

      trackEvent(eventName, collectAnalyticsParams(trigger.dataset));
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return null;
}
