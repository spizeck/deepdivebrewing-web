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
import { TourDatePicker } from "@/components/tour-date-picker";
import { toIsoDate } from "@/lib/calendar";
import {
  TOUR_PRODUCTS,
  buildTourInquiryMessage,
  parseCalendarDate,
  todayCalendarDate,
  validateTourInquiry,
  whatsappUrl,
  type TourProductKey,
} from "@/lib/whatsapp";

interface TourInquiryCtaProps {
  /**
   * Fixed product for the dialog (/contact CTAs). Omit when the trigger is
   * product-agnostic (homepage hero) — the dialog then opens with a compact
   * product choice above the same date/party-size form.
   */
  tour?: TourProductKey;
  /** `cta_location` recorded on the `tour_inquiry_click` handoff event. */
  ctaLocation: string;
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
 * Product-agnostic triggers (homepage hero, Issue #106) omit `tour` and get
 * an extra product choice inside the same dialog; `ctaLocation` keeps the
 * handoff event attributed to the surface that opened it.
 */
export function TourInquiryCta({
  tour,
  ctaLocation,
  variant = "default",
  className,
  children,
}: TourInquiryCtaProps) {
  // Product-agnostic dialogs carry a choice state; fixed-product dialogs
  // ignore it entirely.
  const [selectedTour, setSelectedTour] =
    useState<TourProductKey>("breweryTour");
  const product = TOUR_PRODUCTS[tour ?? selectedTour];
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

  const validation = validateTourInquiry({ date, partySize }, today);
  const errors = attempted && !validation.ok ? validation.errors : {};

  function reset() {
    setDate("");
    setPartySize("");
    setAttempted(false);
    setSelectedTour("breweryTour");
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) reset();
  }

  function handleContinue() {
    setAttempted(true);
    // Re-validate against the real "now" — the render-time `today` could be
    // a minute stale if the modal sat open across midnight.
    const result = validateTourInquiry({ date, partySize });
    if (!result.ok) {
      const firstInvalid = result.errors.date ? dateId : partySizeId;
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    trackEvent("tour_inquiry_click", {
      event_category: "conversion",
      cta_location: ctaLocation,
      event_label: product.label,
    });
    window.open(
      whatsappUrl(buildTourInquiryMessage(product, result.value)),
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
          {tour ? product.label : "Book a Brewery Tour"}
        </DialogTitle>
        {tour && (
          <p className="mt-1 text-sm font-medium text-ink/70">
            ${product.priceUsd} per person · {product.durationLabel}
          </p>
        )}
        <DialogDescription className="mt-1.5 text-sm text-ink/80">
          Tours are by request. We&rsquo;ll confirm availability with you on
          WhatsApp.
        </DialogDescription>
        <form
          className="mt-3 space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleContinue();
          }}
        >
          {/* Product choice — product-agnostic triggers only (Issue #106).
              Native radios in a fieldset give real group semantics; the
              cards just dress them up. Price/duration live here, so the
              generic header drops its per-product price line. */}
          {tour === undefined && (
            <fieldset>
              <legend className="text-sm font-medium text-ink">
                Choose your tour
              </legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(Object.keys(TOUR_PRODUCTS) as TourProductKey[]).map(
                  (key) => {
                    const option = TOUR_PRODUCTS[key];
                    return (
                      <label
                        key={key}
                        className="cursor-pointer rounded-md border border-stone bg-paper px-3 py-1.5 transition-colors has-checked:border-ink has-checked:bg-stone/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ocean/50"
                      >
                        <input
                          type="radio"
                          name={`${uid}-tour`}
                          value={key}
                          checked={selectedTour === key}
                          onChange={() => setSelectedTour(key)}
                          className="sr-only"
                        />
                        <span className="block text-sm font-semibold text-ink">
                          {option.label}
                        </span>
                        {/* Compact rendering of the canonical price/duration
                            — derived, so the cards can't drift from
                            TOUR_PRODUCTS. */}
                        <span className="mt-0.5 block text-xs text-ink/70">
                          ${option.priceUsd}/person ·{" "}
                          {option.durationLabel
                            .replace("About ", "~")
                            .replace(" minutes", " min")}
                        </span>
                      </label>
                    );
                  }
                )}
              </div>
            </fieldset>
          )}
          <div>
            <label
              htmlFor={dateId}
              className="block text-sm font-medium text-ink"
            >
              Preferred date
            </label>
            <TourDatePicker
              id={dateId}
              value={parseCalendarDate(date)}
              onChange={(day) => setDate(toIsoDate(day))}
              min={today}
              invalid={errors.date != null}
              describedBy={errors.date != null ? dateErrorId : undefined}
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
