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
    hero: string;
    label?: string;
  };
  isPublic: boolean;
  sortOrder: number;
}

export interface Venue {
  name: string;
  type: "bar" | "restaurant" | "hotel" | "retail";
  locationName: string;
  carriesBeerSlugs: string[];
  isPublic: boolean;
  links: {
    website?: string;
    instagram?: string;
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
