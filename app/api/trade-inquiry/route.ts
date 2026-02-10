import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

const resend = new Resend(process.env.RESEND_API_KEY);

interface TradeInquiryBody {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
}

export async function POST(req: NextRequest) {
  try {
    const body: TradeInquiryBody = await req.json();

    // Validate required fields
    if (!body.businessName || !body.contactName || !body.email || !body.venueType) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Write to Firestore
    const docRef = await addDoc(collection(db, "tradeLeads"), {
      ...body,
      createdAt: serverTimestamp(),
      status: "new",
    });

    // Send email notification
    const notifyEmail = process.env.TRADE_NOTIFY_EMAIL ?? "info@deepdivebrewing.com";
    // Until your domain is verified in Resend, use onboarding@resend.dev
    // (can only send to the Resend account owner's email in that case)
    const fromEmail = process.env.RESEND_FROM_EMAIL ?? "Deep Dive Brewing <onboarding@resend.dev>";

    console.log("Sending notification to:", notifyEmail, "from:", fromEmail);
    console.log("RESEND_API_KEY set:", !!process.env.RESEND_API_KEY);

    const { data: notifyData, error: notifyError } = await resend.emails.send({
      from: fromEmail,
      to: notifyEmail,
      subject: `New Trade Inquiry from ${body.businessName}`,
      html: `
        <h2>New Trade Inquiry</h2>
        <table style="border-collapse:collapse;width:100%;max-width:600px;">
          <tr><td style="padding:8px;font-weight:bold;">Business</td><td style="padding:8px;">${body.businessName}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Contact</td><td style="padding:8px;">${body.contactName}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;"><a href="mailto:${body.email}">${body.email}</a></td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Phone/WhatsApp</td><td style="padding:8px;">${body.phoneOrWhatsapp || "—"}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Venue Type</td><td style="padding:8px;">${body.venueType}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Message</td><td style="padding:8px;">${body.message || "—"}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666;font-size:13px;">Firestore doc ID: ${docRef.id}</p>
      `,
    });

    if (notifyError) {
      console.error("Resend notify error:", notifyError);
    } else {
      console.log("Notify email sent:", notifyData);
    }

    // Send confirmation to the submitter
    const { data: confirmData, error: confirmError } = await resend.emails.send({
      from: fromEmail,
      to: body.email,
      subject: "We received your trade inquiry — Deep Dive Brewing Co",
      html: `
        <h2>Thanks for reaching out, ${body.contactName}!</h2>
        <p>We've received your trade inquiry for <strong>${body.businessName}</strong> and will get back to you shortly.</p>
        <p>In the meantime, feel free to reach us on WhatsApp at <a href="https://wa.me/15994163544">+1 (599) 416-3544</a>.</p>
        <p>Cheers,<br/>Deep Dive Brewing Co</p>
      `,
    });

    if (confirmError) {
      console.error("Resend confirm error:", confirmError);
    } else {
      console.log("Confirm email sent:", confirmData);
    }

    return NextResponse.json({
      success: true,
      id: docRef.id,
      emailStatus: {
        notify: notifyError ? notifyError.message : "sent",
        confirm: confirmError ? confirmError.message : "sent",
      },
    });
  } catch (error) {
    console.error("Trade inquiry error:", error);
    return NextResponse.json(
      { error: "Failed to submit inquiry" },
      { status: 500 }
    );
  }
}
