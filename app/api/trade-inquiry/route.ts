import { NextRequest, NextResponse } from "next/server";
import { getRequestId, logError } from "@/lib/log";
import { submitTradeInquiry } from "@/lib/trade-leads";
import { tradeLeadFieldTooLong } from "@/lib/trade-leads-common";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const requestLogByIp = new Map<string, number[]>();

interface TradeInquiryBody {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp?: string;
  venueType: string;
  message?: string;
  website?: string;
}

function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  return realIp || "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (requestLogByIp.get(ip) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
  );

  if (recent.length >= RATE_LIMIT_MAX) {
    requestLogByIp.set(ip, recent);
    return true;
  }

  recent.push(now);
  requestLogByIp.set(ip, recent);
  return false;
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  try {
    let body: TradeInquiryBody;
    try {
      body = (await req.json()) as TradeInquiryBody;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid request body." },
        { status: 400 }
      );
    }

    const businessName = body.businessName?.trim() ?? "";
    const contactName = body.contactName?.trim() ?? "";
    const email = body.email?.trim() ?? "";
    const phoneOrWhatsapp = body.phoneOrWhatsapp?.trim() ?? "";
    const venueType = body.venueType?.trim() ?? "";
    const message = body.message?.trim() ?? "";
    const website = body.website?.trim() ?? "";

    if (!businessName || !contactName || !email || !venueType) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Missing required fields: businessName, contactName, email, venueType.",
        },
        { status: 400 }
      );
    }

    const oversized = tradeLeadFieldTooLong({
      businessName,
      contactName,
      email,
      phoneOrWhatsapp,
      venueType,
      message,
    });
    if (oversized) {
      return NextResponse.json(
        { ok: false, error: `Field exceeds maximum length: ${oversized}.` },
        { status: 400 }
      );
    }

    // Honeypot: pretend success for bots, but persist nothing and send no email.
    if (website) {
      return NextResponse.json({ ok: true });
    }

    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
      return NextResponse.json(
        { ok: false, error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    // Firestore is the system of record: the inquiry must be persisted before
    // we claim success. The Resend notification is best-effort inside
    // submitTradeInquiry — its failure is logged, not surfaced to the customer.
    const outcome = await submitTradeInquiry(
      { businessName, contactName, email, phoneOrWhatsapp, venueType, message },
      requestId
    );
    if (!outcome.ok) {
      // Persistence failure was already logged as
      // trade_inquiry.persistence_failed — respond generically.
      return NextResponse.json(
        { ok: false, error: "Failed to submit inquiry." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logError("trade_inquiry.unexpected", error, { requestId });
    return NextResponse.json(
      { ok: false, error: "Failed to submit inquiry." },
      { status: 500 }
    );
  }
}
