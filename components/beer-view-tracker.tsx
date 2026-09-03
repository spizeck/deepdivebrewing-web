"use client";

import { useEffect } from "react";
import { trackEvent } from "@/lib/analytics";

interface BeerViewTrackerProps {
  slug: string;
  name: string;
  style: string;
  status: string;
}

export function BeerViewTracker({ slug, name, style, status }: BeerViewTrackerProps) {
  useEffect(() => {
    trackEvent("beer_detail_view", {
      event_category: "engagement",
      beer_slug: slug,
      beer_name: name,
      beer_style: style,
      event_label: status,
    });
  }, [slug, name, style, status]);

  return null;
}
