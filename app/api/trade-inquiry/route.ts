import { NextRequest, NextResponse } from "next/server";
import { getRequestId, logError } from "@/lib/log";
import { submitTradeInquiry } from "@/lib/trade-leads";
import {
  handleTradeInquiry,
  type TradeInquiryBody,
} from "@/lib/trade-leads-common";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const requestLogByIp = new Map<string, number[]>();

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

    const result = await handleTradeInquiry(
      body,
      { clientIp: getClientIp(req), requestId },
      { isRateLimited, submit: submitTradeInquiry }
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    logError("trade_inquiry.unexpected", error, { requestId });
    return NextResponse.json(
      { ok: false, error: "Something went wrong on our end. Please try again." },
      { status: 500 }
    );
  }
}
