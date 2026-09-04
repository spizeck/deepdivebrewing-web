import { Timestamp } from "firebase/firestore";

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

export interface Venue {
  name: string;
  slug: string;
  type: "bar_restaurant" | "retail";
  locationName: string;
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

export interface TradeLead {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
  createdAt: Timestamp;
  status: string;
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
