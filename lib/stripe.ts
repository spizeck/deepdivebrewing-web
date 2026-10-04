import "server-only";
import Stripe from "stripe";
import { getStripeSecretKey } from "@/lib/stripe-config";

let stripeClient: Stripe | undefined;

// Lazily construct and cache the Stripe client so importing modules never
// require STRIPE_SECRET_KEY at module evaluation (e.g. during `next build`
// page-data collection). The key is validated here, at the API boundary.
export function getStripeClient(): Stripe {
  stripeClient ??= new Stripe(getStripeSecretKey());
  return stripeClient;
}
