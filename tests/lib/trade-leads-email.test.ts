import { describe, it } from "node:test";
import assert from "node:assert";
import {
  deliveryStateForEvent,
  emailPreview,
  escapeHtml,
  extractReplyToken,
  generateReplyToken,
  htmlToPlainText,
  isReplyToken,
  outboundMessageId,
  parseOutboundMessageBody,
  plainTextToHtml,
  replyAddressForToken,
  replyNotificationRecipient,
  resolveInboundThreadId,
  senderDomain,
  serializeTradeLeadCommunication,
  shouldAdvanceDeliveryState,
  TRADE_EMAIL_BODY_MAX,
  TRADE_EMAIL_PREVIEW_LENGTH,
  TRADE_EMAIL_STORED_BODY_MAX,
  TRADE_EMAIL_SUBJECT_MAX,
  TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION,
  truncateEmailBody,
} from "@/lib/trade-leads-email-common";

// Issue #152 — pure domain logic for the trade-lead email pipeline. The
// server module (lib/trade-leads-email.ts) wires Firestore/Resend and is
// covered by these same helpers' contracts.

const REPLY_DOMAIN = "reply.example.com";

describe("reply routing tokens", () => {
  it("generates 8-char tokens from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const token = generateReplyToken();
      assert.strictEqual(token.length, 8);
      assert.match(token, /^[A-HJ-NP-Z2-9]{8}$/);
      // Ambiguous characters are never emitted.
      assert.doesNotMatch(token, /[01ILO]/);
    }
  });

  it("generates distinct tokens", () => {
    const set = new Set(Array.from({ length: 200 }, generateReplyToken));
    assert.ok(set.size > 150, `suspiciously low entropy: ${set.size}/200`);
  });

  it("validates the token shape", () => {
    assert.strictEqual(isReplyToken("7K4M2QX9"), true);
    assert.strictEqual(isReplyToken("7k4m2qx9"), false); // lowercase
    assert.strictEqual(isReplyToken("7K4M2QX"), false); // short
    assert.strictEqual(isReplyToken("7K4M2QX9Z"), false); // long
    assert.strictEqual(isReplyToken("7K4M2QI9"), false); // ambiguous I
    assert.strictEqual(isReplyToken(12345678), false);
    assert.strictEqual(isReplyToken(""), false);
  });

  it("builds the inbound address from token + domain", () => {
    assert.strictEqual(
      replyAddressForToken("7K4M2QX9", REPLY_DOMAIN),
      `7K4M2QX9@${REPLY_DOMAIN}`
    );
  });
});

describe("extractReplyToken", () => {
  it("finds the token in received_for/to/cc recipients", () => {
    assert.strictEqual(
      extractReplyToken([`7K4M2QX9@${REPLY_DOMAIN}`], REPLY_DOMAIN),
      "7K4M2QX9"
    );
    assert.strictEqual(
      extractReplyToken(
        ["staff@example.com", `ABC23456@${REPLY_DOMAIN}`],
        REPLY_DOMAIN
      ),
      "ABC23456"
    );
    assert.strictEqual(
      extractReplyToken(
        [`Lead Attach <7K4M2QX9@${REPLY_DOMAIN}>`],
        REPLY_DOMAIN
      ),
      "7K4M2QX9"
    );
  });

  it("ignores addresses on other domains and non-token local parts", () => {
    assert.strictEqual(
      extractReplyToken(["7K4M2QX9@other.example.com"], REPLY_DOMAIN),
      null
    );
    assert.strictEqual(
      extractReplyToken([`support@${REPLY_DOMAIN}`], REPLY_DOMAIN),
      null
    );
    assert.strictEqual(
      extractReplyToken([`toolongtoken9@${REPLY_DOMAIN}`], REPLY_DOMAIN),
      null
    );
  });

  it("resolves tokens a mail client lowercased in transit", () => {
    assert.strictEqual(
      extractReplyToken([`7k4m2qx9@${REPLY_DOMAIN}`], REPLY_DOMAIN),
      "7K4M2QX9"
    );
  });

  it("matches the domain case-insensitively", () => {
    assert.strictEqual(
      extractReplyToken(["7K4M2QX9@REPLY.EXAMPLE.COM"], REPLY_DOMAIN),
      "7K4M2QX9"
    );
  });

  it("returns null for empty/garbage recipient lists", () => {
    assert.strictEqual(extractReplyToken([], REPLY_DOMAIN), null);
    assert.strictEqual(
      extractReplyToken(["not-an-address", "<>"], REPLY_DOMAIN),
      null
    );
  });
});

describe("delivery states", () => {
  it("maps Resend email.* events to stored states", () => {
    assert.strictEqual(deliveryStateForEvent("email.sent"), "sent");
    assert.strictEqual(deliveryStateForEvent("email.delivered"), "delivered");
    assert.strictEqual(
      deliveryStateForEvent("email.delivery_delayed"),
      "delivery_delayed"
    );
    assert.strictEqual(deliveryStateForEvent("email.bounced"), "bounced");
    assert.strictEqual(deliveryStateForEvent("email.complained"), "complained");
    assert.strictEqual(deliveryStateForEvent("email.failed"), "failed");
    assert.strictEqual(deliveryStateForEvent("email.received"), null);
    assert.strictEqual(deliveryStateForEvent("email.opened"), null);
    assert.strictEqual(deliveryStateForEvent("contact.created"), null);
  });

  it("only advances state rank — replays and out-of-order events ignored", () => {
    assert.strictEqual(shouldAdvanceDeliveryState("queued", "sent"), true);
    assert.strictEqual(shouldAdvanceDeliveryState("sent", "delivered"), true);
    // A delayed "sent" arriving after "delivered" never regresses it.
    assert.strictEqual(shouldAdvanceDeliveryState("delivered", "sent"), false);
    assert.strictEqual(
      shouldAdvanceDeliveryState("delivered", "delivered"),
      false
    );
    // Terminal failures still land after delivery (delayed bounces exist).
    assert.strictEqual(shouldAdvanceDeliveryState("delivered", "bounced"), true);
    assert.strictEqual(shouldAdvanceDeliveryState("bounced", "delivered"), false);
    assert.strictEqual(shouldAdvanceDeliveryState("unknown", "sent"), true);
    assert.strictEqual(shouldAdvanceDeliveryState("sent", "nonsense"), false);
  });
});

describe("parseOutboundMessageBody", () => {
  it("requires a non-empty subject and body", () => {
    assert.strictEqual(
      parseOutboundMessageBody({ subject: "", body: "hi" }).ok,
      false
    );
    assert.strictEqual(
      parseOutboundMessageBody({ subject: "Hi", body: "  " }).ok,
      false
    );
    assert.strictEqual(parseOutboundMessageBody(null).ok, false);
    assert.strictEqual(parseOutboundMessageBody("x").ok, false);
  });

  it("trims and accepts a valid message", () => {
    const result = parseOutboundMessageBody({
      subject: "  Pricing question  ",
      body: "  Hello!\n\nThanks.  ",
      replyToCommunicationId: " comm-1 ",
    });
    assert.ok(result.ok);
    assert.strictEqual(result.message.subject, "Pricing question");
    assert.strictEqual(result.message.body, "Hello!\n\nThanks.");
    assert.strictEqual(result.message.replyToCommunicationId, "comm-1");
  });

  it("passes retryCommunicationId through for idempotent resends", () => {
    const result = parseOutboundMessageBody({
      subject: "Hi",
      body: "hello",
      retryCommunicationId: " comm-9 ",
    });
    assert.ok(result.ok);
    assert.strictEqual(result.message.retryCommunicationId, "comm-9");
    // Absent on a fresh send.
    const fresh = parseOutboundMessageBody({ subject: "Hi", body: "hello" });
    assert.ok(fresh.ok);
    assert.strictEqual(fresh.message.retryCommunicationId, undefined);
  });

  it("caps subject and body length", () => {
    assert.strictEqual(
      parseOutboundMessageBody({
        subject: "x".repeat(TRADE_EMAIL_SUBJECT_MAX + 1),
        body: "hi",
      }).ok,
      false
    );
    assert.strictEqual(
      parseOutboundMessageBody({
        subject: "hi",
        body: "x".repeat(TRADE_EMAIL_BODY_MAX + 1),
      }).ok,
      false
    );
  });

  it("strips CR/LF from the subject — header injection cannot survive", () => {
    const result = parseOutboundMessageBody({
      subject: "Hi\r\nBCC: victim@example.com",
      body: "hello",
    });
    assert.ok(result.ok);
    assert.strictEqual(result.message.subject, "Hi BCC: victim@example.com");
    assert.doesNotMatch(result.message.subject, /[\r\n]/);
  });
});

describe("inbound body normalization", () => {
  it("truncates oversized mail and marks it", () => {
    const big = "x".repeat(TRADE_EMAIL_STORED_BODY_MAX + 10);
    const result = truncateEmailBody(big);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.text.length, TRADE_EMAIL_STORED_BODY_MAX);
    const small = truncateEmailBody("hello");
    assert.strictEqual(small.truncated, false);
  });

  it("converts HTML to plain text and strips script/style blocks", () => {
    const html = `<p>Hello<br>there</p><script>alert(1)</script><p>Second</p>`;
    const text = htmlToPlainText(html);
    assert.strictEqual(text, "Hello\nthere\n\nSecond");
    assert.ok(!text.includes("alert"));
    assert.ok(!text.includes("<"));
  });

  it("decodes common entities", () => {
    assert.strictEqual(
      htmlToPlainText("<p>Tom &amp; Jerry &lt;3 &quot;tunes&quot;</p>"),
      'Tom & Jerry <3 "tunes"'
    );
  });

  it("escapes outbound text before wrapping it in minimal HTML", () => {
    assert.strictEqual(
      escapeHtml(`<b>"'</b> &`),
      "&lt;b&gt;&quot;&#039;&lt;/b&gt; &amp;"
    );
    const html = plainTextToHtml("Hi\n\nBye <script>");
    assert.strictEqual(html, "<p>Hi</p><p>Bye &lt;script&gt;</p>");
  });

  it("builds a single-line preview capped at the preview length", () => {
    const preview = emailPreview("  Hello\n\n  world  ");
    assert.strictEqual(preview, "Hello world");
    const long = emailPreview("x".repeat(TRADE_EMAIL_PREVIEW_LENGTH + 5));
    assert.strictEqual(long.length, TRADE_EMAIL_PREVIEW_LENGTH + 1); // …
    assert.ok(long.endsWith("…"));
  });
});

describe("threading", () => {
  it("resolves the thread via In-Reply-To matching a stored Message-ID", () => {
    const candidates = [
      { id: "c1", messageId: "<c1@mail.example.com>", threadId: "c1" },
      { id: "c2", messageId: "<c2@mail.example.com>", threadId: "c1" },
    ];
    assert.strictEqual(
      resolveInboundThreadId(
        candidates,
        { inReplyTo: "<c2@mail.example.com>" },
        "new-id"
      ),
      "c1"
    );
  });

  it("resolves via References when In-Reply-To is absent", () => {
    const candidates = [
      { id: "root", messageId: "<root@mail.example.com>" },
    ];
    assert.strictEqual(
      resolveInboundThreadId(
        candidates,
        { references: ["<other@x>", "<root@mail.example.com>"] },
        "new-id"
      ),
      "root"
    );
  });

  it("starts a new thread (self id) when nothing matches", () => {
    assert.strictEqual(
      resolveInboundThreadId(
        [{ id: "c1", messageId: "<c1@mail.example.com>" }],
        { inReplyTo: "<unknown@x>" },
        "self"
      ),
      "self"
    );
    // No threading headers at all — e.g. a forwarded email — is its own
    // thread; lead-level correlation already happened via the token.
    assert.strictEqual(
      resolveInboundThreadId([{ id: "c1", messageId: "<c1@m>" }], {}, "self"),
      "self"
    );
  });

  it("builds a deterministic RFC Message-ID on the sender's domain", () => {
    assert.strictEqual(
      outboundMessageId("comm-42", "mail.example.com"),
      "<comm-42@mail.example.com>"
    );
  });

  it("extracts the domain from display-name and bare senders", () => {
    assert.strictEqual(
      senderDomain("Deep Dive <trade@mail.example.com>"),
      "mail.example.com"
    );
    assert.strictEqual(senderDomain("trade@mail.example.com"), "mail.example.com");
    assert.strictEqual(senderDomain("garbage"), "localhost");
  });
});

describe("replyNotificationRecipient", () => {
  it("prefers the assigned owner's admin email", () => {
    assert.strictEqual(
      replyNotificationRecipient("owner@example.com", "trade@example.com"),
      "owner@example.com"
    );
  });

  it("falls back to the shared mailbox for unassigned leads", () => {
    assert.strictEqual(
      replyNotificationRecipient(undefined, "trade@example.com"),
      "trade@example.com"
    );
    assert.strictEqual(
      replyNotificationRecipient("  ", "trade@example.com"),
      "trade@example.com"
    );
    assert.strictEqual(
      replyNotificationRecipient(null, "trade@example.com"),
      "trade@example.com"
    );
  });

  it("returns undefined when no target exists — never sends blindly", () => {
    assert.strictEqual(replyNotificationRecipient(null, undefined), undefined);
    assert.strictEqual(replyNotificationRecipient("", " "), undefined);
  });
});

describe("serializeTradeLeadCommunication", () => {
  const ts = (iso: string) => ({
    toMillis: () => new Date(iso).getTime(),
    toDate: () => new Date(iso),
  });

  it("serializes an outbound record with threading metadata", () => {
    const view = serializeTradeLeadCommunication("comm-1", {
      channel: "email",
      direction: "outbound",
      from: "Deep Dive <trade@mail.example.com>",
      to: ["venue@example.com"],
      cc: ["cc@example.com"],
      subject: "Pricing",
      textBody: "Hello!",
      providerEmailId: "re_123",
      messageId: "<comm-1@mail.example.com>",
      threadId: "comm-1",
      sentAt: ts("2026-10-02T15:00:00.000Z"),
      sentByName: "Chad",
      deliveryState: "delivered",
      createdAt: ts("2026-10-02T15:00:00.000Z"),
    });
    assert.strictEqual(view.direction, "outbound");
    assert.deepStrictEqual(view.to, ["venue@example.com"]);
    assert.strictEqual(view.messageId, "<comm-1@mail.example.com>");
    assert.strictEqual(view.threadId, "comm-1");
    assert.strictEqual(view.deliveryState, "delivered");
    assert.strictEqual(view.sentAt, "2026-10-02T15:00:00.000Z");
  });

  it("serializes inbound records and filters malformed attachments", () => {
    const view = serializeTradeLeadCommunication("inb_1", {
      direction: "inbound",
      from: "customer@example.com",
      to: `7K4M2QX9@${REPLY_DOMAIN}`,
      subject: "Re: Pricing",
      textBody: "Thanks!",
      attachments: [
        { filename: "list.pdf", contentType: "application/pdf", size: 1024 },
        "garbage",
        { filename: 42 },
      ],
      deliveryState: "received",
      createdAt: ts("2026-10-02T16:00:00.000Z"),
    });
    assert.strictEqual(view.direction, "inbound");
    assert.strictEqual(view.deliveryState, "received");
    assert.strictEqual(view.attachments?.length, 2);
    assert.strictEqual(view.attachments?.[0]?.filename, "list.pdf");
    assert.strictEqual(view.attachments?.[1]?.filename, undefined);
  });

  it("tolerates missing fields — partial records still render", () => {
    const view = serializeTradeLeadCommunication("c", {});
    assert.strictEqual(view.direction, "outbound");
    assert.deepStrictEqual(view.to, []);
    assert.strictEqual(view.deliveryState, undefined);
  });
});

describe("subcollection naming", () => {
  it("uses the communications subcollection under tradeLeads", () => {
    assert.strictEqual(
      TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION,
      "communications"
    );
  });
});
