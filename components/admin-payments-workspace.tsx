"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AdminPanelUser } from "@/components/admin-access";
import { formatAdminDate, formatAdminDateTime } from "@/lib/admin-format";
import {
  describePaymentEvent,
  formatUsdMinor,
  isPaymentCancelable,
  isPaymentPayable,
  parseAmountMinor,
  paymentPurposeLabel,
  paymentStatusLabel,
  suggestedAmountMinor,
  PAYMENT_PURPOSES,
  type PaymentEventView,
  type PaymentStatus,
  type PaymentView,
} from "@/lib/payments-common";

// Input/select borders use ink at 50% so every form control boundary is
// visible against the paper background (WCAG 1.4.11 non-text contrast).
const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2";
const sectionLabelClass =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";

interface PaymentDetail {
  payment: PaymentView;
  events: PaymentEventView[];
}

const EMPTY_FORM = {
  purpose: "brewery_tour",
  // Prefilled from the default purpose so the form never shows "Brewery
  // Tour" selected with a blank required description.
  description: paymentPurposeLabel("brewery_tour"),
  amount: "",
  customerName: "",
  customerEmail: "",
  tourDate: "",
  attendeeCount: "",
  internalNote: "",
};

type FormState = typeof EMPTY_FORM;

// Form → confirm → created. `confirm` forces an explicit look at the amount
// before the Stripe session exists.
type TakeStep = "form" | "confirm" | "created";

const STATUS_BADGE_CLASS: Record<PaymentStatus, string> = {
  created: "border-border text-muted-foreground",
  awaiting_payment: "border-ocean/40 bg-ocean/10 text-ocean",
  processing: "border-amber-500/40 bg-amber-100/70 text-amber-900",
  paid: "border-moss/40 bg-moss/10 text-moss",
  failed: "border-ember/40 bg-ember/10 text-ember",
  expired: "border-border text-muted-foreground",
  canceled: "border-border text-muted-foreground",
};

function StatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <Badge variant="outline" className={STATUS_BADGE_CLASS[status]}>
      {paymentStatusLabel(status)}
    </Badge>
  );
}

function paymentMillis(iso?: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Poll a created payment until it resolves or the customer has had a
// reasonable window to pay; afterwards the explicit Refresh button stays.
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 30;

export function AdminPaymentsWorkspace({ user }: { user: AdminPanelUser }) {
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusIsError, setStatusIsError] = useState(false);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [amountTouched, setAmountTouched] = useState(false);
  const [step, setStep] = useState<TakeStep>("form");
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  // Idempotency handle for the whole "take payment" action: generated once
  // per flow so a double-click, timeout retry, or accidental resubmit can
  // never mint a second charge.
  const clientRequestIdRef = useRef<string>(crypto.randomUUID());
  const [activePayment, setActivePayment] = useState<PaymentDetail | null>(
    null
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const selectedIdRef = useRef<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrForId, setQrForId] = useState<string | null>(null);
  const pollCountRef = useRef(0);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      > & { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        throw new Error(data.error ?? "Request failed.");
      }
      return data;
    },
    [user]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/admin/payments");
      setPayments((data.payments as PaymentView[]) ?? []);
    } catch (error) {
      console.error(error);
      setStatusMessage("Failed to load payments.");
      setStatusIsError(true);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keeps the shared list truthful whenever a fresh record arrives.
  const upsertPayment = useCallback((payment: PaymentView) => {
    setPayments((prev) => {
      const exists = prev.some((p) => p.id === payment.id);
      if (exists) {
        return prev.map((p) => (p.id === payment.id ? payment : p));
      }
      return [payment, ...prev];
    });
  }, []);

  const openPayment = useCallback(
    async (id: string) => {
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetailLoading(true);
      setDetail(null);
      setQrUrl(null);
      setQrForId(null);
      try {
        const data = await apiFetch(`/api/admin/payments/${id}`);
        const next = {
          payment: data.payment as PaymentView,
          events: (data.events as PaymentEventView[]) ?? [],
        };
        upsertPayment(next.payment);
        if (selectedIdRef.current !== id) return;
        setDetail(next);
      } catch (error) {
        if (selectedIdRef.current !== id) return;
        console.error(error);
        setStatusMessage("Failed to load the selected payment.");
        setStatusIsError(true);
      } finally {
        if (selectedIdRef.current === id) setDetailLoading(false);
      }
    },
    [apiFetch, upsertPayment]
  );

  function closeDetail() {
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
  }

  // Manual/server-side reconcile used by both the Refresh button and the
  // auto-poll after creation. Applies to whichever detail object is live.
  const refreshPayment = useCallback(
    async (id: string): Promise<PaymentDetail | null> => {
      try {
        const data = await apiFetch(`/api/admin/payments/${id}/refresh`, {
          method: "POST",
        });
        const next = {
          payment: data.payment as PaymentView,
          events: (data.events as PaymentEventView[]) ?? [],
        };
        upsertPayment(next.payment);
        setActivePayment((prev) =>
          prev?.payment.id === id ? next : prev
        );
        if (selectedIdRef.current === id) setDetail(next);
        return next;
      } catch {
        return null;
      }
    },
    [apiFetch, upsertPayment]
  );

  // While a freshly created payment is unresolved, poll the refresh
  // endpoint — a paid card usually lands within seconds.
  useEffect(() => {
    const id = activePayment?.payment.id;
    const status = activePayment?.payment.status;
    if (!id || (status !== "awaiting_payment" && status !== "processing")) {
      return;
    }
    pollCountRef.current = 0;
    const timer = setInterval(() => {
      pollCountRef.current += 1;
      if (pollCountRef.current > POLL_MAX_ATTEMPTS) {
        clearInterval(timer);
        return;
      }
      void refreshPayment(id);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activePayment?.payment.id, activePayment?.payment.status, refreshPayment]);

  // --- Take payment ---

  const attendeeNumber = Number(form.attendeeCount);
  const suggestedMinor = suggestedAmountMinor(
    form.purpose,
    Number.isInteger(attendeeNumber) && attendeeNumber > 0
      ? attendeeNumber
      : undefined
  );

  function updateField<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Purpose drives the default description; attendee count drives the
      // suggested amount until staff edits the amount by hand.
      if (key === "purpose") {
        next.description = paymentPurposeLabel(value);
        if (!amountTouched) {
          const count = Number(next.attendeeCount);
          const minor = suggestedAmountMinor(
            value,
            Number.isInteger(count) && count > 0 ? count : undefined
          );
          next.amount = minor === null ? "" : (minor / 100).toFixed(2);
        }
      }
      if (key === "attendeeCount" && !amountTouched) {
        const count = Number(value);
        const minor = suggestedAmountMinor(
          prev.purpose,
          Number.isInteger(count) && count > 0 ? count : undefined
        );
        next.amount = minor === null ? "" : (minor / 100).toFixed(2);
      }
      return next;
    });
  }

  function reviewPayment(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const amount = parseAmountMinor(form.amount);
    if (!amount.ok) {
      setFormError(amount.error);
      return;
    }
    setStep("confirm");
  }

  async function createPayment() {
    if (creating) return; // single-flight: no parallel session creation
    setCreating(true);
    setFormError("");
    try {
      const data = await apiFetch("/api/admin/payments", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: clientRequestIdRef.current,
          purpose: form.purpose,
          description: form.description,
          amount: form.amount,
          customerName: form.customerName,
          customerEmail: form.customerEmail,
          tourDate: form.tourDate,
          attendeeCount: form.attendeeCount,
          internalNote: form.internalNote,
        }),
      });
      const payment = data.payment as PaymentView;
      const detailData = await apiFetch(`/api/admin/payments/${payment.id}`);
      const next = {
        payment: detailData.payment as PaymentView,
        events: (detailData.events as PaymentEventView[]) ?? [],
      };
      upsertPayment(payment);
      setActivePayment(next);
      setStep("created");
      setStatusMessage("Payment link created.");
      setStatusIsError(false);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Could not create the payment."
      );
      setStep("form");
    } finally {
      setCreating(false);
    }
  }

  // Done/reset: a new request id so the next take-payment action is a fresh
  // logical operation.
  function resetTakePayment() {
    clientRequestIdRef.current = crypto.randomUUID();
    setForm(EMPTY_FORM);
    setAmountTouched(false);
    setStep("form");
    setFormError("");
    setActivePayment(null);
    setQrUrl(null);
    setQrForId(null);
  }

  async function copyLink(payment: PaymentView) {
    if (!payment.stripeSessionUrl) return;
    try {
      await navigator.clipboard.writeText(payment.stripeSessionUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatusMessage("Could not copy — copy the link by hand.");
      setStatusIsError(true);
    }
  }

  async function showQr(payment: PaymentView) {
    if (qrForId === payment.id && qrUrl) {
      setQrUrl(null);
      setQrForId(null);
      return;
    }
    try {
      const data = await apiFetch(`/api/admin/payments/${payment.id}/qr`);
      setQrUrl((data.dataUrl as string) ?? null);
      setQrForId(payment.id);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not create the QR code."
      );
      setStatusIsError(true);
    }
  }

  async function cancelPayment(payment: PaymentView) {
    if (busy) return;
    const confirmed = window.confirm(
      `Cancel this ${formatUsdMinor(payment.amountMinor)} payment for ${payment.customerName}? The payment link will stop working.`
    );
    if (!confirmed) return;
    setBusy("cancel");
    try {
      const data = await apiFetch(`/api/admin/payments/${payment.id}/cancel`, {
        method: "POST",
      });
      const next = {
        payment: data.payment as PaymentView,
        events: (data.events as PaymentEventView[]) ?? [],
      };
      upsertPayment(next.payment);
      setActivePayment((prev) =>
        prev?.payment.id === payment.id ? next : prev
      );
      if (selectedIdRef.current === payment.id) setDetail(next);
      setStatusMessage("Payment canceled.");
      setStatusIsError(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not cancel the payment."
      );
      setStatusIsError(true);
    } finally {
      setBusy(null);
    }
  }

  // --- Derived view ---

  const summary = useMemo(() => {
    let awaiting = 0;
    let paidTodayMinor = 0;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    for (const p of payments) {
      if (p.status === "awaiting_payment" || p.status === "processing") {
        awaiting++;
      }
      if (p.status === "paid" && paymentMillis(p.paidAt) >= startOfToday.getTime()) {
        paidTodayMinor += p.amountMinor;
      }
    }
    return { awaiting, paidTodayMinor };
  }, [payments]);

  const reviewMinor = parseAmountMinor(form.amount);
  const shownPayment = detail?.payment ?? null;
  const timeline = detail
    ? [...detail.events].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    : [];

  function paymentLinkBlock(payment: PaymentView) {
    if (!isPaymentPayable(payment.status) || !payment.stripeSessionUrl) {
      return null;
    }
    return (
      <div className="mt-3 rounded-md border border-stone bg-paper p-3">
        <p className={sectionLabelClass}>Customer payment link</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {payment.stripeSessionUrl}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyLink(payment)}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void showQr(payment)}
          >
            {qrForId === payment.id && qrUrl ? "Hide QR" : "Show QR"}
          </Button>
          <Button type="button" size="sm" variant="outline" asChild>
            <a
              href={payment.stripeSessionUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open payment page
            </a>
          </Button>
        </div>
        {qrForId === payment.id && qrUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- data URL QR, not a routed image
          <img
            src={qrUrl}
            alt={`QR code linking to the payment page for ${payment.customerName}`}
            className="mt-3 h-40 w-40 rounded-md border border-stone bg-white p-1"
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-stone bg-paper px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Payments</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Link href="/admin" className="text-ocean hover:underline">
                Admin dashboard
              </Link>{" "}
              → Payments
            </p>
          </div>
          {!loading && (
            <p className="text-xs text-muted-foreground">
              {summary.awaiting} awaiting ·{" "}
              {formatUsdMinor(summary.paidTodayMinor)} collected today
            </p>
          )}
        </div>
        {statusMessage && (
          <p
            role="status"
            className={`mt-2 text-sm ${statusIsError ? "text-ember" : "text-ocean"}`}
          >
            {statusMessage}
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Take payment --- */}
        <section
          aria-label="Take payment"
          className="rounded-lg border border-stone bg-paper p-5"
        >
          {step === "form" && (
            <>
              <h2 className="font-semibold">Take payment</h2>
              <form className="mt-3 space-y-3" onSubmit={reviewPayment}>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Purpose</span>
                  <select
                    className={fieldClass}
                    value={form.purpose}
                    onChange={(e) => updateField("purpose", e.target.value)}
                  >
                    {PAYMENT_PURPOSES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">
                      Attendees <span className="font-normal text-muted-foreground">(optional)</span>
                    </span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      className={fieldClass}
                      value={form.attendeeCount}
                      onChange={(e) =>
                        updateField("attendeeCount", e.target.value)
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">
                      Tour date <span className="font-normal text-muted-foreground">(optional)</span>
                    </span>
                    <input
                      type="date"
                      className={fieldClass}
                      value={form.tourDate}
                      onChange={(e) => updateField("tourDate", e.target.value)}
                    />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    Description<span aria-hidden="true" className="text-ember"> *</span>
                  </span>
                  <input
                    required
                    className={fieldClass}
                    value={form.description}
                    onChange={(e) => updateField("description", e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    Amount (USD)<span aria-hidden="true" className="text-ember"> *</span>
                  </span>
                  <input
                    required
                    inputMode="decimal"
                    placeholder="40.00"
                    className={fieldClass}
                    value={form.amount}
                    onChange={(e) => {
                      setAmountTouched(true);
                      updateField("amount", e.target.value);
                    }}
                  />
                  {suggestedMinor !== null && !amountTouched && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Suggested {formatUsdMinor(suggestedMinor)} — edit anytime.
                    </span>
                  )}
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">
                      Customer name<span aria-hidden="true" className="text-ember"> *</span>
                    </span>
                    <input
                      required
                      className={fieldClass}
                      value={form.customerName}
                      onChange={(e) =>
                        updateField("customerName", e.target.value)
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">
                      Receipt email <span className="font-normal text-muted-foreground">(optional)</span>
                    </span>
                    <input
                      type="email"
                      className={fieldClass}
                      value={form.customerEmail}
                      onChange={(e) =>
                        updateField("customerEmail", e.target.value)
                      }
                    />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    Internal note <span className="font-normal text-muted-foreground">(optional)</span>
                  </span>
                  <input
                    className={fieldClass}
                    value={form.internalNote}
                    onChange={(e) => updateField("internalNote", e.target.value)}
                  />
                </label>
                {formError && (
                  <p role="alert" className="text-sm text-ember">
                    {formError}
                  </p>
                )}
                <Button type="submit" className="w-full sm:w-auto">
                  Review payment
                </Button>
              </form>
            </>
          )}

          {step === "confirm" && reviewMinor.ok && (
            <>
              <h2 className="font-semibold">Confirm charge</h2>
              <div className="mt-3 rounded-md border border-stone bg-stone/20 p-4 text-center">
                <p className="text-3xl font-bold tracking-tight">
                  {formatUsdMinor(reviewMinor.minor)}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {form.description} — {form.customerName}
                </p>
              </div>
              {formError && (
                <p role="alert" className="mt-2 text-sm text-ember">
                  {formError}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  onClick={() => void createPayment()}
                  disabled={creating}
                >
                  {creating ? "Creating…" : "Create payment"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setStep("form")}
                  disabled={creating}
                >
                  Back
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                The customer enters their card on Stripe&apos;s secure page —
                card details never touch this app.
              </p>
            </>
          )}

          {step === "created" && activePayment && (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">Payment created</h2>
                <div className="flex items-center gap-2">
                  {activePayment.payment.livemode === false && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 bg-amber-100/70 text-amber-900"
                    >
                      Test mode
                    </Badge>
                  )}
                  <StatusBadge status={activePayment.payment.status} />
                </div>
              </div>
              <p className="mt-2 text-2xl font-bold tracking-tight">
                {formatUsdMinor(activePayment.payment.amountMinor)}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {activePayment.payment.description} —{" "}
                {activePayment.payment.customerName}
              </p>
              {activePayment.payment.status === "paid" ? (
                <p role="status" className="mt-3 text-sm font-medium text-moss">
                  Payment received.
                </p>
              ) : (
                <p role="status" className="mt-3 text-sm text-muted-foreground">
                  Waiting for the customer to pay…
                </p>
              )}
              {paymentLinkBlock(activePayment.payment)}
              {isPaymentCancelable(activePayment.payment.status) && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  disabled={busy === "cancel"}
                  onClick={() => void cancelPayment(activePayment.payment)}
                >
                  {busy === "cancel" ? "Canceling…" : "Cancel payment"}
                </Button>
              )}
              <div className="mt-4 border-t border-stone pt-3">
                <Button variant="outline" size="sm" onClick={resetTakePayment}>
                  Take another payment
                </Button>
              </div>
            </>
          )}
        </section>

        {/* --- Recent payments --- */}
        <section
          aria-label="Recent payments"
          className="rounded-lg border border-stone bg-paper p-4"
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Recent payments</h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? "Loading…" : "Reload"}
            </Button>
          </div>
          {loading && payments.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          ) : payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No payments yet.
            </p>
          ) : (
            <ul className="divide-y divide-stone">
              {payments.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-current={selectedId === p.id}
                    onClick={() => void openPayment(p.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm ${
                      selectedId === p.id ? "bg-stone/40" : "hover:bg-stone/20"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {p.customerName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.description} · {formatAdminDateTime(p.createdAt)}
                        {p.createdByName ? ` · ${p.createdByName}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="font-medium">
                        {formatUsdMinor(p.amountMinor)}
                      </span>
                      <StatusBadge status={p.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* --- Selected payment detail --- */}
      {selectedId && (
        <section
          aria-label="Payment detail"
          className="rounded-lg border border-stone bg-paper p-5"
        >
          {detailLoading || !shownPayment ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading payment…
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">
                      {shownPayment.customerName}
                    </h2>
                    {shownPayment.livemode === false && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-100/70 text-amber-900"
                      >
                        Test mode
                      </Badge>
                    )}
                    <StatusBadge status={shownPayment.status} />
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {formatUsdMinor(shownPayment.amountMinor)} ·{" "}
                    {shownPayment.description}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === "refresh"}
                    onClick={() => {
                      setBusy("refresh");
                      void refreshPayment(shownPayment.id).finally(() =>
                        setBusy(null)
                      );
                    }}
                  >
                    {busy === "refresh" ? "Refreshing…" : "Refresh status"}
                  </Button>
                  {isPaymentCancelable(shownPayment.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === "cancel"}
                      onClick={() => void cancelPayment(shownPayment)}
                    >
                      {busy === "cancel" ? "Canceling…" : "Cancel payment"}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={closeDetail}>
                    Close
                  </Button>
                </div>
              </div>

              {paymentLinkBlock(shownPayment)}

              <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className={sectionLabelClass}>Purpose</dt>
                  <dd>{paymentPurposeLabel(shownPayment.purpose)}</dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Created</dt>
                  <dd>{formatAdminDateTime(shownPayment.createdAt)}</dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Created by</dt>
                  <dd>{shownPayment.createdByName || "—"}</dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Receipt email</dt>
                  <dd>{shownPayment.customerEmail || "—"}</dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Tour date</dt>
                  <dd>
                    {shownPayment.tourDate
                      ? formatAdminDate(shownPayment.tourDate)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Attendees</dt>
                  <dd>{shownPayment.attendeeCount ?? "—"}</dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Paid at</dt>
                  <dd>{formatAdminDateTime(shownPayment.paidAt)}</dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Card</dt>
                  <dd>
                    {shownPayment.paymentMethodBrand
                      ? `${shownPayment.paymentMethodBrand} ···· ${shownPayment.paymentMethodLast4 ?? ""}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Receipt</dt>
                  <dd>
                    {shownPayment.receiptUrl ? (
                      <a
                        href={shownPayment.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ocean hover:underline"
                      >
                        View receipt
                      </a>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>Stripe session</dt>
                  <dd className="break-all text-xs">
                    {shownPayment.stripeCheckoutSessionId ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className={sectionLabelClass}>PaymentIntent</dt>
                  <dd className="break-all text-xs">
                    {shownPayment.stripePaymentIntentId ?? "—"}
                  </dd>
                </div>
                {shownPayment.internalNote && (
                  <div className="sm:col-span-2 lg:col-span-3">
                    <dt className={sectionLabelClass}>Internal note</dt>
                    <dd className="whitespace-pre-wrap">
                      {shownPayment.internalNote}
                    </dd>
                  </div>
                )}
                {shownPayment.failureMessage && (
                  <div className="sm:col-span-2 lg:col-span-3">
                    <dt className={sectionLabelClass}>Failure</dt>
                    <dd className="text-ember">{shownPayment.failureMessage}</dd>
                  </div>
                )}
              </dl>

              <div className="mt-4 border-t border-stone pt-3">
                <h3 className={sectionLabelClass}>History</h3>
                <ul className="mt-2 space-y-1.5">
                  {timeline.map((e) => (
                    <li key={e.id} className="text-sm">
                      <span className="text-muted-foreground">
                        {formatAdminDateTime(e.createdAt)}
                      </span>
                      {" — "}
                      {describePaymentEvent(e)}
                      {e.actorName ? ` (${e.actorName})` : ""}
                    </li>
                  ))}
                  {timeline.length === 0 && (
                    <li className="text-sm text-muted-foreground">
                      No history yet.
                    </li>
                  )}
                </ul>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
