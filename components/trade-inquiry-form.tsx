"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/analytics";

interface FormData {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
  website: string;
}

const initialFormData: FormData = {
  businessName: "",
  contactName: "",
  email: "",
  phoneOrWhatsapp: "",
  venueType: "",
  message: "",
  website: "",
};

const venueTypes = ["Bar", "Restaurant", "Hotel", "Retail", "Distributor", "Other"];

export function TradeInquiryForm() {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const statusRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) {
    if (!startedRef.current) {
      startedRef.current = true;
      trackEvent("trade_form_start", { event_category: "conversion", cta_location: "trade_page" });
    }
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("/api/trade-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Submit failed");
      }

      setStatus("success");
      setFormData(initialFormData);
      trackEvent("trade_form_success", {
        event_category: "conversion",
        cta_location: "trade_page",
        venue_type: formData.venueType,
      });
    } catch (err) {
      setStatus("error");
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setErrorMessage(message);
      trackEvent("trade_form_error", {
        event_category: "conversion",
        cta_location: "trade_page",
        venue_type: formData.venueType,
      });
    }
  }

  useEffect(() => {
    if (status === "success" && successRef.current) {
      successRef.current.focus();
    }
    if (status === "error" && statusRef.current) {
      statusRef.current.focus();
    }
  }, [status]);

  if (status === "success") {
    return (
      <div
        ref={successRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="rounded-lg border border-moss/30 bg-moss/5 p-8 text-center outline-none focus-visible:ring-2 focus-visible:ring-moss/50"
      >
        <p className="font-semibold text-ink">Thank you for your inquiry.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          We&apos;ll be in touch soon.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Honeypot: hidden from humans and assistive technology */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={formData.website}
          onChange={handleChange}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <FormField
          label="Business Name"
          name="businessName"
          value={formData.businessName}
          onChange={handleChange}
          required
        />
        <FormField
          label="Contact Name"
          name="contactName"
          value={formData.contactName}
          onChange={handleChange}
          required
        />
        <FormField
          label="Email"
          name="email"
          type="email"
          value={formData.email}
          onChange={handleChange}
          required
        />
        <FormField
          label="Phone / WhatsApp"
          name="phoneOrWhatsapp"
          value={formData.phoneOrWhatsapp}
          onChange={handleChange}
        />
      </div>

      <div>
        <label htmlFor="venueType" className="mb-2 block text-sm font-medium text-ink">
          Venue Type
        </label>
        <select
          id="venueType"
          name="venueType"
          value={formData.venueType}
          onChange={handleChange}
          required
          className="min-h-[44px] w-full rounded-md border border-stone bg-paper px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-ocean/50"
        >
          <option value="">Select type...</option>
          {venueTypes.map((type) => (
            <option key={type} value={type.toLowerCase()}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="message" className="mb-2 block text-sm font-medium text-ink">
          Message
        </label>
        <textarea
          id="message"
          name="message"
          rows={4}
          value={formData.message}
          onChange={handleChange}
          className="w-full rounded-md border border-stone bg-paper px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-ocean/50"
          placeholder="Tell us about your business and what you're looking for..."
        />
      </div>

      <div
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="outline-none focus-visible:ring-2 focus-visible:ring-ember/50"
      >
        {status === "error" && (
          <p className="text-sm text-ember">
            {errorMessage || "Something went wrong. Please try again."}
          </p>
        )}
      </div>

      <Button type="submit" disabled={status === "submitting"} className="h-11 min-h-[44px] px-6">
        {status === "submitting" ? "Sending..." : "Submit Inquiry"}
      </Button>
    </form>
  );
}

function FormField({
  label,
  name,
  type = "text",
  value,
  onChange,
  required = false,
}: {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-2 block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        className="min-h-[44px] w-full rounded-md border border-stone bg-paper px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-ocean/50"
      />
    </div>
  );
}
