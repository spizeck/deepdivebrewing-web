"use client";

import Link from "next/link";
import { trackEvent, type AnalyticsEventName, type AnalyticsEventParams } from "@/lib/analytics";

interface TrackedLinkProps extends React.ComponentProps<typeof Link> {
  eventName: AnalyticsEventName;
  eventParams?: AnalyticsEventParams;
}

export function TrackedLink({
  eventName,
  eventParams,
  onClick,
  ...props
}: TrackedLinkProps) {
  return (
    <Link
      {...props}
      onClick={(e) => {
        trackEvent(eventName, eventParams);
        onClick?.(e);
      }}
    />
  );
}

interface TrackedAnchorProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  eventName: AnalyticsEventName;
  eventParams?: AnalyticsEventParams;
}

export function TrackedAnchor({
  eventName,
  eventParams,
  onClick,
  ...props
}: TrackedAnchorProps) {
  return (
    <a
      {...props}
      onClick={(e) => {
        trackEvent(eventName, eventParams);
        onClick?.(e);
      }}
    />
  );
}
