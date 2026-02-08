import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface TradeLeadInput {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
}

export async function submitTradeLead(data: TradeLeadInput): Promise<string> {
  const docRef = await addDoc(collection(db, "tradeLeads"), {
    ...data,
    createdAt: serverTimestamp(),
    status: "new",
  });
  return docRef.id;
}
