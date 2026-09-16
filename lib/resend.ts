import "server-only";
import { Resend } from "resend";
import { getResendApiKey } from "@/lib/resend-config";

let resendClient: Resend | undefined;

// Lazily construct and cache the Resend client so importing modules never
// require RESEND_API_KEY at module evaluation (e.g. during `next build`
// page-data collection). The key is validated here, at the send boundary.
export function getResendClient(): Resend {
  resendClient ??= new Resend(getResendApiKey());
  return resendClient;
}
