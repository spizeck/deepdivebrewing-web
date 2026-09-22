import { describe, it } from "node:test";
import assert from "node:assert";
import {
  addCalendarDays,
  compareCalendarDates,
  daysInMonth,
  formatCalendarDate,
  monthGrid,
  monthName,
  toIsoDate,
} from "../../lib/calendar";
import { parseCalendarDate } from "../../lib/whatsapp";

describe("toIsoDate / parseCalendarDate", () => {
  it("round-trips a calendar date through the input wire format", () => {
    const d = { year: 2026, month: 10, day: 8 };
    assert.equal(toIsoDate(d), "2026-10-08");
    assert.deepEqual(parseCalendarDate(toIsoDate(d)), d);
  });

  it("zero-pads single-digit months and days", () => {
    assert.equal(toIsoDate({ year: 2027, month: 1, day: 3 }), "2027-01-03");
  });
});

describe("addCalendarDays", () => {
  it("crosses month and year boundaries without timezone shifts", () => {
    assert.deepEqual(
      addCalendarDays({ year: 2026, month: 1, day: 31 }, 1),
      { year: 2026, month: 2, day: 1 }
    );
    assert.deepEqual(
      addCalendarDays({ year: 2026, month: 12, day: 31 }, 1),
      { year: 2027, month: 1, day: 1 }
    );
    assert.deepEqual(
      addCalendarDays({ year: 2026, month: 3, day: 1 }, -1),
      { year: 2026, month: 2, day: 28 }
    );
    // Leap year.
    assert.deepEqual(
      addCalendarDays({ year: 2028, month: 2, day: 28 }, 1),
      { year: 2028, month: 2, day: 29 }
    );
  });
});

describe("compareCalendarDates", () => {
  it("orders past < today < future", () => {
    const today = { year: 2026, month: 9, day: 22 };
    assert.ok(compareCalendarDates({ year: 2026, month: 9, day: 21 }, today) < 0);
    assert.equal(compareCalendarDates(today, { ...today }), 0);
    assert.ok(compareCalendarDates({ year: 2026, month: 9, day: 23 }, today) > 0);
    assert.ok(compareCalendarDates({ year: 2025, month: 12, day: 31 }, today) < 0);
  });
});

describe("monthGrid", () => {
  it("produces Sunday-first weeks covering the whole month", () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthGrid(2026, 10);
    assert.ok(weeks.every((w) => w.length === 7));
    // First cell is Sunday Oct 4? No — Oct 1 2026 is Thursday, so Sun–Wed are null.
    assert.equal(weeks[0][0], null);
    assert.equal(weeks[0][3], null);
    assert.deepEqual(weeks[0][4], { year: 2026, month: 10, day: 1 });
    const flat = weeks.flat().filter(Boolean);
    assert.equal(flat.length, 31);
    assert.deepEqual(flat.at(-1), { year: 2026, month: 10, day: 31 });
  });

  it("handles February and leap years", () => {
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2028, 2), 29);
    const weeks = monthGrid(2028, 2);
    assert.equal(weeks.flat().filter(Boolean).length, 29);
  });
});

describe("formatCalendarDate", () => {
  it("renders an unambiguous full date", () => {
    assert.equal(
      formatCalendarDate({ year: 2026, month: 10, day: 12 }),
      "October 12, 2026"
    );
    assert.equal(monthName(1), "January");
  });
});
