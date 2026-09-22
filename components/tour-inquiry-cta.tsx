"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { trackEvent } from "@/lib/analytics";
import {
  TOUR_PRODUCTS,
  buildTourInquiryMessage,
  todayCalendarDate,
  validateTourInquiry,
  whatsappUrl,
  type TourProductKey,
} from "@/lib/whatsapp";

interface TourInquiryCtaProps {
  tour: TourProductKey;
  variant?: "default" | "outline";
  className?: string;
  children: React.ReactNode;
}

const inputClass =
  "mt-1.5 h-11 min-h-[44px] w-full rounded-md border border-stone bg-paper px-3 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean/50 aria-[invalid=true]:border-ember";

/**
 * Tour CTA that opens a lightweight inquiry dialog (Issue #102) instead of
 * handing straight off to WhatsApp. Collects only a preferred date and party
 * size — transient UI state, nothing persisted — then builds the pre-filled
 * message and opens the canonical wa.me link. The `tour_inquiry_click`
 * analytics event fires only on a successful Continue, not on modal open.
 */
export function TourInquiryCta({
  tour,
  variant = "default",
  className,
  children,
}: TourInquiryCtaProps) {
  const product = TOUR_PRODUCTS[tour];
  const uid = useId();
  const dateId = `${uid}-date`;
  const dateErrorId = `${uid}-date-error`;
  const partySizeId = `${uid}-party-size`;
  const partySizeErrorId = `${uid}-party-size-error`;

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [partySize, setPartySize] = useState("");
  const [attempted, setAttempted] = useState(false);

  const today = todayCalendarDate();
  const todayIso = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;

  const validation = validateTourInquiry({ date, partySize }, today);
  const errors = attempted && !validation.ok ? validation.errors : {};

  function reset() {
    setDate("");
    setPartySize("");
    setAttempted(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) reset();
  }

  function handleContinue() {
    setAttempted(true);
    if (!validation.ok) {
      const firstInvalid = validation.errors.date ? dateId : partySizeId;
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    trackEvent("tour_inquiry_click", {
      event_category: "conversion",
      cta_location: "contact_page_tours",
      event_label: product.label,
    });
    window.open(
      whatsappUrl(buildTourInquiryMessage(product, validation.value)),
      "_blank",
      "noopener,noreferrer"
    );
    setOpen(false);
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant} className={className}>
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle className="text-xl font-semibold text-ink pr-12">
          {product.label}
        </DialogTitle>
        <p className="mt-1 text-sm font-medium text-ink/70">
          ${product.priceUsd} per person · {product.durationLabel}
        </p>
        <DialogDescription className="mt-3 text-sm text-ink/80">
          Tours are by request. We&rsquo;ll confirm availability with you on
          WhatsApp.
        </DialogDescription>
        <form
          className="mt-5 space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleContinue();
          }}
        >
          <div>
            <label
              htmlFor={dateId}
              className="block text-sm font-medium text-ink"
            >
              Preferred date
            </label>
            <input
              id={dateId}
              type="date"
              required
              min={todayIso}
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={errors.date != null}
              aria-describedby={errors.date != null ? dateErrorId : undefined}
              className={inputClass}
            />
            {errors.date != null && (
              <p
                id={dateErrorId}
                role="alert"
                className="mt-1.5 text-sm text-ember"
              >
                {errors.date}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor={partySizeId}
              className="block text-sm font-medium text-ink"
            >
              Party size
            </label>
            <input
              id={partySizeId}
              type="number"
              required
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="Number of people"
              value={partySize}
              onChange={(event) => setPartySize(event.target.value)}
              aria-invalid={errors.partySize != null}
              aria-describedby={
                errors.partySize != null ? partySizeErrorId : undefined
              }
              className={inputClass}
            />
            {errors.partySize != null && (
              <p
                id={partySizeErrorId}
                role="alert"
                className="mt-1.5 text-sm text-ember"
              >
                {errors.partySize}
              </p>
            )}
          </div>
          <Button
            type="submit"
            className="h-11 min-h-[44px] w-full px-6 text-base"
          >
            Continue to WhatsApp
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
