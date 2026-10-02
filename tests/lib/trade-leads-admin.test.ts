import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLeadUpdate,
  classifyFollowUp,
  DELETE_FIELD,
  describeTradeLeadActivity,
  isManualLeadSource,
  isTerminalLeadStatus,
  isTradeLeadStatus,
  normalizeTradeLeadStatus,
  parseLeadPatchBody,
  parseManualLeadBody,
  serializeTradeLead,
  serializeTradeLeadActivity,
  tradeLeadSourceLabel,
  tradeLeadStatusLabel,
  TRADE_LEAD_NOTE_MAX_LENGTH,
  validateNoteBody,
  type TradeLeadActivityView,
} from "@/lib/trade-leads-admin-common";

const NOW = new Date("2026-10-02T15:00:00.000Z");
const TODAY = { year: 2026, month: 10, day: 2 };

// Firestore-shaped timestamp stand-in (admin Timestamp has toMillis).
const ts = (iso: string) => ({
  toMillis: () => new Date(iso).getTime(),
  toDate: () => new Date(iso),
});

describe("status model", () => {
  it("keeps the pre-pipeline 'new' status valid for existing leads", () => {
    assert.strictEqual(isTradeLeadStatus("new"), true);
    assert.strictEqual(normalizeTradeLeadStatus("new"), "new");
  });

  it("normalizes missing/unknown statuses to 'new' for reads and filters", () => {
    for (const value of [undefined, null, "", "garbage", 42]) {
      assert.strictEqual(normalizeTradeLeadStatus(value), "new");
    }
  });

  it("treats customer and closed as terminal", () => {
    assert.strictEqual(isTerminalLeadStatus("customer"), true);
    assert.strictEqual(isTerminalLeadStatus("closed"), true);
    assert.strictEqual(isTerminalLeadStatus("follow_up"), false);
    assert.strictEqual(isTerminalLeadStatus("new"), false);
  });

  it("labels statuses for display", () => {
    assert.strictEqual(tradeLeadStatusLabel("follow_up"), "Follow-up");
    assert.strictEqual(tradeLeadStatusLabel("bogus"), "New");
  });
});

describe("source model", () => {
  it("labels known sources and preserves unknown strings", () => {
    assert.strictEqual(tradeLeadSourceLabel("trade_form"), "Website form");
    assert.strictEqual(tradeLeadSourceLabel("whatsapp"), "WhatsApp");
    assert.strictEqual(tradeLeadSourceLabel("carrier_pigeon"), "carrier_pigeon");
    assert.strictEqual(tradeLeadSourceLabel(""), "Unknown");
  });

  it("keeps trade_form out of the manual-source set", () => {
    assert.strictEqual(isManualLeadSource("trade_form"), false);
    assert.strictEqual(isManualLeadSource("whatsapp"), true);
    assert.strictEqual(isManualLeadSource("referral"), true);
    assert.strictEqual(isManualLeadSource("bogus"), false);
  });
});

describe("classifyFollowUp", () => {
  const followUpIso = (year: number, month: number, day: number) =>
    // Local-midnight instant, matching what the admin UI writes.
    new Date(year, month - 1, day).toISOString();

  it("classifies overdue, due today, and upcoming by calendar day", () => {
    assert.strictEqual(
      classifyFollowUp(followUpIso(2026, 10, 1), "contacted", TODAY),
      "overdue"
    );
    assert.strictEqual(
      classifyFollowUp(followUpIso(2026, 10, 2), "contacted", TODAY),
      "due_today"
    );
    assert.strictEqual(
      classifyFollowUp(followUpIso(2026, 10, 3), "contacted", TODAY),
      "upcoming"
    );
  });

  it("returns none when no follow-up is set or the value is unparseable", () => {
    assert.strictEqual(classifyFollowUp(undefined, "new", TODAY), "none");
    assert.strictEqual(classifyFollowUp(null, "new", TODAY), "none");
    assert.strictEqual(classifyFollowUp("not a date", "new", TODAY), "none");
  });

  it("never reports overdue on customer/closed leads", () => {
    const past = followUpIso(2026, 9, 1);
    assert.strictEqual(classifyFollowUp(past, "customer", TODAY), "none");
    assert.strictEqual(classifyFollowUp(past, "closed", TODAY), "none");
  });
});

describe("parseLeadPatchBody", () => {
  it("accepts a status patch", () => {
    const result = parseLeadPatchBody({ status: "contacted" });
    assert.ok(result.ok);
    assert.strictEqual(result.patch.status, "contacted");
  });

  it("rejects unknown status values", () => {
    assert.deepStrictEqual(parseLeadPatchBody({ status: "nope" }), {
      ok: false,
      error: "Unknown lead status.",
    });
  });

  it("accepts uid assignment and null unassignment", () => {
    const assign = parseLeadPatchBody({ assignedToUid: " uid-1 " });
    assert.ok(assign.ok);
    assert.strictEqual(assign.patch.assignedToUid, "uid-1");
    const clear = parseLeadPatchBody({ assignedToUid: null });
    assert.ok(clear.ok);
    assert.strictEqual(clear.patch.assignedToUid, null);
  });

  it("rejects malformed assignee values", () => {
    assert.strictEqual(parseLeadPatchBody({ assignedToUid: "" }).ok, false);
    assert.strictEqual(parseLeadPatchBody({ assignedToUid: 42 }).ok, false);
  });

  it("accepts a follow-up instant, null clear, and rejects garbage", () => {
    const set = parseLeadPatchBody({ nextFollowUpAt: "2026-10-18T04:00:00.000Z" });
    assert.ok(set.ok);
    assert.strictEqual(set.patch.nextFollowUpAt?.toISOString(), "2026-10-18T04:00:00.000Z");
    const clear = parseLeadPatchBody({ nextFollowUpAt: null });
    assert.ok(clear.ok);
    assert.strictEqual(clear.patch.nextFollowUpAt, null);
    assert.strictEqual(parseLeadPatchBody({ nextFollowUpAt: "junk" }).ok, false);
    assert.strictEqual(parseLeadPatchBody({ nextFollowUpAt: {} }).ok, false);
  });

  it("rejects a follow-up implausibly far in the future", () => {
    const result = parseLeadPatchBody({ nextFollowUpAt: "2999-01-01T00:00:00.000Z" });
    assert.strictEqual(result.ok, false);
  });

  it("trims outcome text, clears on empty/null, and enforces the cap", () => {
    const set = parseLeadPatchBody({ outcome: "  Became a customer  " });
    assert.ok(set.ok);
    assert.strictEqual(set.patch.outcome, "Became a customer");
    const clear = parseLeadPatchBody({ outcome: null });
    assert.ok(clear.ok);
    assert.strictEqual(clear.patch.outcome, null);
    assert.strictEqual(
      parseLeadPatchBody({ outcome: "x".repeat(201) }).ok,
      false
    );
  });

  it("requires at least one recognized field", () => {
    assert.strictEqual(parseLeadPatchBody({}).ok, false);
    assert.strictEqual(parseLeadPatchBody({ unrelated: true }).ok, false);
    assert.strictEqual(parseLeadPatchBody("string").ok, false);
    assert.strictEqual(parseLeadPatchBody([1, 2]).ok, false);
  });
});

describe("buildLeadUpdate", () => {
  const lead = {
    status: "new",
    assignedToUid: "admin-1",
    assignedToName: "Chad",
    nextFollowUpAt: ts("2026-10-05T04:00:00.000Z"),
  };

  it("records a status change with from/to in the timeline", () => {
    const result = buildLeadUpdate(lead, { status: "contacted" }, NOW);
    assert.ok(result.ok);
    assert.strictEqual(result.plan.updates.status, "contacted");
    assert.deepStrictEqual(result.plan.activities, [
      {
        type: "status_changed",
        details: { from: "new", to: "contacted" },
      },
    ]);
  });

  it("is a no-op when the patch repeats current values", () => {
    const result = buildLeadUpdate(lead, { status: "new" }, NOW);
    assert.ok(result.ok);
    assert.strictEqual(result.plan.changed, false);
    assert.deepStrictEqual(result.plan.updates, {});
    assert.deepStrictEqual(result.plan.activities, []);
  });

  it("sets closedAt and clears a pending follow-up when a lead goes terminal", () => {
    const result = buildLeadUpdate(lead, { status: "closed" }, NOW);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.plan.updates.closedAt, NOW);
    assert.strictEqual(result.plan.updates.nextFollowUpAt, DELETE_FIELD);
    assert.deepStrictEqual(
      result.plan.activities.map((a) => a.type),
      ["status_changed", "follow_up_cleared"]
    );
  });

  it("stores a provided outcome when a lead goes terminal", () => {
    const result = buildLeadUpdate(
      lead,
      { status: "customer", outcome: "First order placed" },
      NOW
    );
    assert.ok(result.ok);
    assert.strictEqual(result.plan.updates.outcome, "First order placed");
    // Outcome is part of the append-only history, not a silent field update.
    assert.deepStrictEqual(
      result.plan.activities.map((a) => a.type),
      ["status_changed", "follow_up_cleared", "outcome_changed"]
    );
  });

  it("records outcome changes and clears in the timeline", () => {
    const closed = { status: "closed", outcome: "No fit" };
    const changed = buildLeadUpdate(
      closed,
      { outcome: "Went with a competitor" },
      NOW
    );
    assert.ok(changed.ok);
    assert.deepStrictEqual(changed.plan.activities, [
      {
        type: "outcome_changed",
        details: { from: "No fit", to: "Went with a competitor" },
      },
    ]);
    assert.strictEqual(changed.plan.updates.outcome, "Went with a competitor");

    const cleared = buildLeadUpdate(closed, { outcome: null }, NOW);
    assert.ok(cleared.ok);
    assert.strictEqual(cleared.plan.updates.outcome, DELETE_FIELD);
    assert.deepStrictEqual(cleared.plan.activities[0]?.details, {
      from: "No fit",
      to: null,
    });
  });

  it("clears closedAt/outcome when a terminal lead reopens", () => {
    const result = buildLeadUpdate(
      { ...lead, status: "closed", outcome: "No fit" },
      { status: "contacted" },
      NOW
    );
    assert.ok(result.ok);
    assert.strictEqual(result.plan.updates.closedAt, DELETE_FIELD);
    assert.strictEqual(result.plan.updates.outcome, DELETE_FIELD);
  });

  it("rejects an outcome on a non-terminal lead", () => {
    const result = buildLeadUpdate(lead, { outcome: "won" }, NOW);
    assert.strictEqual(result.ok, false);
  });

  it("ignores a follow-up set on a terminal lead", () => {
    const result = buildLeadUpdate(
      { status: "closed" },
      { nextFollowUpAt: new Date("2026-10-20T00:00:00.000Z") },
      NOW
    );
    assert.ok(result.ok);
    assert.strictEqual(result.plan.changed, false);
  });

  it("records owner assignment, reassignment, and unassignment", () => {
    const assigned = buildLeadUpdate(
      { status: "new" },
      { assignee: { uid: "u-1", name: "Chad" } },
      NOW
    );
    assert.ok(assigned.ok);
    assert.strictEqual(assigned.plan.updates.assignedToUid, "u-1");
    assert.strictEqual(assigned.plan.updates.assignedToName, "Chad");
    assert.deepStrictEqual(assigned.plan.activities[0]?.details?.to, "Chad");

    const reassigned = buildLeadUpdate(lead, { assignee: { uid: "u-2", name: "Malachy" } }, NOW);
    assert.ok(reassigned.ok);
    assert.deepStrictEqual(reassigned.plan.activities[0]?.details, {
      from: "Chad",
      to: "Malachy",
    });

    const unassigned = buildLeadUpdate(lead, { assignee: null }, NOW);
    assert.ok(unassigned.ok);
    assert.strictEqual(unassigned.plan.updates.assignedToUid, DELETE_FIELD);
    assert.deepStrictEqual(unassigned.plan.activities[0]?.details, {
      from: "Chad",
      to: null,
    });
  });

  it("distinguishes follow-up set vs change vs clear", () => {
    const set = buildLeadUpdate(
      { status: "contacted" },
      { nextFollowUpAt: new Date("2026-10-10T00:00:00.000Z") },
      NOW
    );
    assert.ok(set.ok);
    assert.strictEqual(set.plan.activities[0]?.type, "follow_up_set");
    assert.strictEqual(
      set.plan.activities[0]?.details?.at,
      "2026-10-10T00:00:00.000Z"
    );

    const moved = buildLeadUpdate(
      lead,
      { nextFollowUpAt: new Date("2026-10-18T00:00:00.000Z") },
      NOW
    );
    assert.ok(moved.ok);
    assert.strictEqual(moved.plan.activities[0]?.type, "follow_up_changed");
    assert.deepStrictEqual(moved.plan.activities[0]?.details, {
      at: "2026-10-18T00:00:00.000Z",
      from: "2026-10-05T04:00:00.000Z",
    });

    const cleared = buildLeadUpdate(lead, { nextFollowUpAt: null }, NOW);
    assert.ok(cleared.ok);
    assert.strictEqual(cleared.plan.activities[0]?.type, "follow_up_cleared");
    assert.strictEqual(cleared.plan.updates.nextFollowUpAt, DELETE_FIELD);
  });

  it("advances updatedAt/lastActivityAt only on meaningful changes", () => {
    const changed = buildLeadUpdate(lead, { status: "contacted" }, NOW);
    assert.ok(changed.ok);
    assert.deepStrictEqual(changed.plan.updates.updatedAt, NOW);
    assert.deepStrictEqual(changed.plan.updates.lastActivityAt, NOW);

    const noop = buildLeadUpdate(lead, { status: "new" }, NOW);
    assert.ok(noop.ok);
    assert.strictEqual("updatedAt" in noop.plan.updates, false);
  });
});

describe("parseManualLeadBody", () => {
  const base = {
    businessName: "Harbour Bar",
    contactName: "Sam",
    email: "sam@harbour.example",
    phoneOrWhatsapp: "+599 555 1234",
    venueType: "bar",
    message: "Met at the trade show.",
    source: "event",
  };

  it("accepts a complete manual lead", () => {
    const result = parseManualLeadBody(base);
    assert.ok(result.ok);
    assert.strictEqual(result.input.businessName, "Harbour Bar");
    assert.strictEqual(result.input.source, "event");
  });

  it("requires a business name", () => {
    assert.strictEqual(parseManualLeadBody({ ...base, businessName: "  " }).ok, false);
  });

  it("requires at least one contact channel", () => {
    const result = parseManualLeadBody({ ...base, email: "", phoneOrWhatsapp: "" });
    assert.strictEqual(result.ok, false);
    const phoneOnly = parseManualLeadBody({ ...base, email: "" });
    assert.ok(phoneOnly.ok);
    const emailOnly = parseManualLeadBody({ ...base, phoneOrWhatsapp: "" });
    assert.ok(emailOnly.ok);
  });

  it("rejects trade_form as a manual source — that source is written by the public flow", () => {
    assert.strictEqual(parseManualLeadBody({ ...base, source: "trade_form" }).ok, false);
  });

  it("rejects unknown sources and validates optional email format", () => {
    assert.strictEqual(parseManualLeadBody({ ...base, source: "smoke_signal" }).ok, false);
    assert.strictEqual(parseManualLeadBody({ ...base, email: "not-an-email" }).ok, false);
  });

  it("defaults venueType to 'other' and rejects non-canonical values", () => {
    const defaulted = parseManualLeadBody({ ...base, venueType: "" });
    assert.ok(defaulted.ok);
    assert.strictEqual(defaulted.input.venueType, "other");
    assert.strictEqual(parseManualLeadBody({ ...base, venueType: "garbage" }).ok, false);
  });
});

describe("validateNoteBody", () => {
  it("requires non-empty trimmed text within the cap", () => {
    assert.deepStrictEqual(validateNoteBody("  hello  "), { ok: true, note: "hello" });
    assert.strictEqual(validateNoteBody("   ").ok, false);
    assert.strictEqual(validateNoteBody(42).ok, false);
    assert.strictEqual(
      validateNoteBody("x".repeat(TRADE_LEAD_NOTE_MAX_LENGTH + 1)).ok,
      false
    );
    assert.ok(validateNoteBody("x".repeat(TRADE_LEAD_NOTE_MAX_LENGTH)).ok);
  });
});

describe("serializers", () => {
  it("serializes a lead with ISO timestamps and normalized status", () => {
    const view = serializeTradeLead("lead-1", {
      businessName: "Bar",
      contactName: "Sam",
      email: "s@x.example",
      phoneOrWhatsapp: "",
      venueType: "bar",
      message: "",
      status: "legacy-value",
      source: "trade_form",
      createdAt: ts("2026-01-01T00:00:00.000Z"),
      updatedAt: ts("2026-01-02T00:00:00.000Z"),
      nextFollowUpAt: ts("2026-10-18T04:00:00.000Z"),
    });
    assert.strictEqual(view.status, "new");
    assert.strictEqual(view.createdAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(view.nextFollowUpAt, "2026-10-18T04:00:00.000Z");
    assert.strictEqual(view.assignedToUid, undefined);
  });

  it("serializes an activity", () => {
    const view = serializeTradeLeadActivity("a-1", {
      type: "status_changed",
      seq: 3,
      authorUid: "u-1",
      authorName: "Chad",
      details: { from: "new", to: "contacted" },
      createdAt: ts("2026-10-02T15:00:00.000Z"),
    });
    assert.strictEqual(view.type, "status_changed");
    assert.strictEqual(view.seq, 3);
    assert.strictEqual(view.authorName, "Chad");
    assert.strictEqual(view.createdAt, "2026-10-02T15:00:00.000Z");
  });
});

describe("describeTradeLeadActivity", () => {
  const act = (
    type: string,
    details?: TradeLeadActivityView["details"]
  ) => describeTradeLeadActivity({ type, details });

  it("renders each mutation type as a readable line", () => {
    assert.strictEqual(act("lead_created", { source: "whatsapp" }), "Lead created — WhatsApp");
    assert.strictEqual(
      act("status_changed", { from: "contacted", to: "follow_up" }),
      "Status changed from Contacted to Follow-up"
    );
    assert.strictEqual(act("owner_changed", { to: "Chad" }), "Assigned to Chad");
    assert.strictEqual(act("owner_changed", { to: null }), "Owner unassigned");
    assert.strictEqual(act("follow_up_cleared"), "Follow-up cleared");
    assert.strictEqual(
      act("outcome_changed", { to: "First order placed" }),
      "Outcome updated: First order placed"
    );
    assert.strictEqual(act("outcome_changed", { to: null }), "Outcome cleared");
    assert.strictEqual(act("note"), "Note");
  });

  it("renders the reserved communication type for future messages", () => {
    assert.strictEqual(
      describeTradeLeadActivity({
        type: "communication",
        communication: { channel: "email", direction: "outbound" },
      }),
      "Message sent via email"
    );
  });
});

// Route + script wiring asserted on source — the same convention as
// tests/lib/trade-leads.test.ts for modules that pull in server-only deps.
describe("admin trade-lead wiring", () => {
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  it("every trade-lead API route goes through requireAdminActor", () => {
    for (const rel of [
      "app/api/admin/trade-leads/route.ts",
      "app/api/admin/trade-leads/[id]/route.ts",
      "app/api/admin/trade-leads/[id]/activities/route.ts",
    ]) {
      assert.ok(
        read(rel).includes("requireAdminActor"),
        `${rel} must enforce the admin-actor invariant`
      );
    }
  });

  it("the public submission writes a lead_created activity with the lead", () => {
    const source = read("lib/trade-leads.ts");
    assert.ok(source.includes("TRADE_LEAD_ACTIVITIES_SUBCOLLECTION"));
    assert.ok(source.includes('"lead_created"'));
  });

  it("the prune script removes the activities subcollection with the lead", () => {
    const source = read("scripts/prune-trade-leads.ts");
    assert.ok(source.includes("TRADE_LEAD_ACTIVITIES_SUBCOLLECTION"));
    // Activities are batch-deleted after the lead's transaction commits —
    // a long history must never overflow a single transaction's write limit.
    assert.ok(source.includes("deleteLeadActivities"));
    assert.ok(source.includes("batch.delete(doc.ref)"));
  });
});
