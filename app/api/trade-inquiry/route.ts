import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
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
  try {
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "Email service is not configured." },
        { status: 500 }
      );
    }

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

    // Honeypot: pretend success for bots, but do not send email.
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

    const toEmail = process.env.TRADE_INQUIRY_TO_EMAIL;
    if (!toEmail) {
      return NextResponse.json(
        { ok: false, error: "Destination email is not configured." },
        { status: 500 }
      );
    }

    const subject = `Trade Inquiry — ${businessName} (${contactName})`;
    const html = `
      <h2>New Trade Inquiry</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        <tr><td style="padding: 8px; font-weight: 700;">Business Name</td><td style="padding: 8px;">${businessName}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Contact Name</td><td style="padding: 8px;">${contactName}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Email</td><td style="padding: 8px;"><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Phone / WhatsApp</td><td style="padding: 8px;">${phoneOrWhatsapp || "—"}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Venue Type</td><td style="padding: 8px;">${venueType}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Message</td><td style="padding: 8px;">${message || "—"}</td></tr>
      </table>
    `;

    const { error } = await resend.emails.send({
      from: "Deep Dive Brewing <DeepDiveBrewing@mail.seasaba.com>",
      to: toEmail,
      replyTo: email,
      subject,
      html,
    });

    if (error) {
      console.error("Trade inquiry email error:", error);
      return NextResponse.json(
        { ok: false, error: "Failed to send inquiry email." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Trade inquiry error:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to submit inquiry." },
      { status: 500 }
    );
  }
}
