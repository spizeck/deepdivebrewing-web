export interface Beer {
  name: string;
  slug: string;
  style: string;
  abv: number;
  ibu: number | null;
  srm: number | null;
  status: "core" | "seasonal" | "limited";
  descriptionShort: string;
  tastingNotes: string[];
  images: {
    cardPath: string;
    heroPath: string;
  };
  isPublic: boolean;
  sortOrder: number;
}

import type { VenueIsland } from "@/lib/venue-islands";

export interface Venue {
  name: string;
  slug: string;
  type: "bar_restaurant" | "retail";
  // Free-text locality (e.g. "Windwardside", "Philipsburg") shown on the
  // venue card. Never used for island grouping — that is `island`'s job.
  locationName: string;
  // Canonical island key ("saba" | "sxm" | "statia"). Optional only because
  // legacy documents predate the field; reads fall back to parsing
  // `locationName` for those records (see lib/venue-filters.ts).
  island?: VenueIsland;
  carriesBeerSlugs: string[];
  tapBeerSlugs?: string[];
  canBeerSlugs?: string[];
  isPublic: boolean;
  sortOrder: number;
  links: {
    website?: string;
    maps?: string;
    instagram?: string;
    facebook?: string;
    untappd?: string;
  };
  notesPublic?: string;
}

export type AdminRole = "superadmin" | "admin";
export type AdminStatus = "active" | "disabled";

export interface AdminUserView {
  uid: string;
  email: string;
  displayName?: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  lastLoginAt?: string;
}

export interface AdminInvitationView {
  id: string;
  email: string;
  role: AdminRole;
  status: "pending" | "accepted" | "cancelled";
  invitedBy: string;
  createdAt: string;
  acceptedAt?: string;
  acceptedBy?: string;
  emailStatus?: "pending" | "sent" | "failed";
  lastEmailAttemptAt?: string;
  messageId?: string;
}
