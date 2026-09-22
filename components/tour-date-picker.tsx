"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  addCalendarDays,
  compareCalendarDates,
  formatCalendarDate,
  monthGrid,
  monthName,
  toIsoDate,
} from "@/lib/calendar";
import type { CalendarDate } from "@/lib/whatsapp";

interface TourDatePickerProps {
  id: string;
  value: CalendarDate | null;
  onChange: (date: CalendarDate) => void;
  /** Earliest selectable date — the visitor's local today. */
  min: CalendarDate;
  invalid?: boolean;
  describedBy?: string;
}

const WEEKDAYS = [
  { short: "Su", long: "Sunday" },
  { short: "Mo", long: "Monday" },
  { short: "Tu", long: "Tuesday" },
  { short: "We", long: "Wednesday" },
  { short: "Th", long: "Thursday" },
  { short: "Fr", long: "Friday" },
  { short: "Sa", long: "Saturday" },
] as const;

const ARROW_MOVES: Record<string, number> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  ArrowDown: 7,
  ArrowUp: -7,
};

/**
 * Accessible calendar field for the tour inquiry modal (Issue #102). Replaces
 * `<input type="date">`: native date pickers do not reliably prevent choosing
 * a past date — `min` disables days in Chromium's popup but keyboard entry
 * into the segmented field bypasses it, and other engines do not enforce it
 * in their pickers either. Here, days before `min` are aria-disabled and can
 * never be selected; `validateTourInquiry` remains the authoritative check.
 *
 * The calendar is an in-flow disclosure panel beneath the field, not a
 * floating popover: it expands the dialog so every form control stays
 * visible and the dialog never scrolls on normal viewports (Issue #108).
 * A floating layer inside the dialog's transformed, `overflow-y-auto` box
 * was what produced the scrollbar and clipped grid this replaced.
 * Dismissal keeps the popover-era semantics: Escape closes only the
 * calendar (never the whole dialog), outside presses dismiss it without
 * disturbing the dialog, and selecting a day returns focus to the field.
 */
export function TourDatePicker({
  id,
  value,
  onChange,
  min,
  invalid,
  describedBy,
}: TourDatePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ year: min.year, month: min.month });
  const [focusedIso, setFocusedIso] = useState(toIsoDate(value ?? min));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const panelId = `${id}-panel`;

  function openPicker() {
    const start = value ?? min;
    setView({ year: start.year, month: start.month });
    setFocusedIso(toIsoDate(start));
    setOpen(true);
  }

  // Roving focus: arrow keys (and open) change focusedIso; the DOM focus
  // follows once the grid for the target month has rendered.
  useEffect(() => {
    if (!open) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${focusedIso}"]`)
      ?.focus();
  }, [focusedIso, open]);

  // While the calendar is open: outside presses dismiss it (the press itself
  // still lands — e.g. focusing party size — and the dialog stays open), and
  // Escape dismisses only the calendar. Escape must be captured at window
  // level because the dialog's own Escape handler listens on document in the
  // capture phase and would otherwise close the whole dialog first.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  function handleDayKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    day: CalendarDate
  ) {
    const move = ARROW_MOVES[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const next = addCalendarDays(day, move);
    if (next.year !== view.year || next.month !== view.month) {
      setView({ year: next.year, month: next.month });
    }
    setFocusedIso(toIsoDate(next));
  }

  function select(day: CalendarDate) {
    if (compareCalendarDates(day, min) < 0) return;
    onChange(day);
    setOpen(false);
    triggerRef.current?.focus();
  }

  const atMinMonth = view.year === min.year && view.month === min.month;
  const weeks = monthGrid(view.year, view.month);
  const todayIso = toIsoDate(min);
  const selectedIso = value ? toIsoDate(value) : null;

  return (
    <div ref={rootRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        data-invalid={invalid}
        aria-describedby={describedBy}
        aria-haspopup="grid"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={cn(
          "mt-1.5 flex h-11 min-h-[44px] w-full items-center justify-between rounded-md border border-stone bg-paper px-3 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean/50 data-[invalid=true]:border-ember",
          !value && "text-ink/70"
        )}
      >
        <span>{value ? formatCalendarDate(value) : "Select a date"}</span>
        <CalendarIcon className="size-4 text-ink/50" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Choose a date"
          className="mt-1 w-full rounded-lg border border-stone bg-paper p-1.5"
        >
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              disabled={atMinMonth}
              onClick={() =>
                setView((v) =>
                  v.month === 1
                    ? { year: v.year - 1, month: 12 }
                    : { year: v.year, month: v.month - 1 }
                )
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/70 transition-colors hover:bg-stone disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean/50"
            >
              <ChevronLeft className="size-5" aria-hidden="true" />
            </button>
            <span
              className="text-sm font-semibold text-ink"
              aria-hidden="true"
            >
              {monthName(view.month)} {view.year}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() =>
                setView((v) =>
                  v.month === 12
                    ? { year: v.year + 1, month: 1 }
                    : { year: v.year, month: v.month + 1 }
                )
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/70 transition-colors hover:bg-stone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean/50"
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </button>
          </div>
          <div
            role="grid"
            ref={gridRef}
            aria-label={`${monthName(view.month)} ${view.year}`}
          >
            <div role="row" className="grid grid-cols-7">
              {WEEKDAYS.map((d) => (
                <span
                  key={d.long}
                  role="columnheader"
                  aria-label={d.long}
                  className="flex h-7 items-center justify-center text-xs font-medium text-ink/70"
                >
                  {d.short}
                </span>
              ))}
            </div>
            {weeks.map((week, i) => (
              <div key={i} role="row" className="grid grid-cols-7">
                {week.map((day, j) =>
                  day === null ? (
                    <span key={j} role="gridcell" />
                  ) : (
                    <span
                      key={j}
                      role="gridcell"
                      aria-selected={toIsoDate(day) === selectedIso}
                    >
                      <button
                        type="button"
                        data-date={toIsoDate(day)}
                        aria-label={formatCalendarDate(day)}
                        aria-disabled={compareCalendarDates(day, min) < 0}
                        aria-current={
                          toIsoDate(day) === todayIso ? "date" : undefined
                        }
                        data-selected={toIsoDate(day) === selectedIso}
                        tabIndex={toIsoDate(day) === focusedIso ? 0 : -1}
                        onClick={() => select(day)}
                        onKeyDown={(e) => handleDayKeyDown(e, day)}
                        className="mx-auto flex h-8 w-full max-w-8 items-center justify-center rounded-full text-sm text-ink transition-colors hover:bg-stone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean/50 aria-[disabled=true]:text-ink/30 aria-[disabled=true]:hover:bg-transparent data-[selected=true]:bg-ink data-[selected=true]:text-paper"
                      >
                        {day.day}
                      </button>
                    </span>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
