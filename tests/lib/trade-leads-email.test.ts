import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildTradeLeadOutboundHtml,
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
  retryWithinIdempotencyWindow,
  senderDomain,
  serializeTradeLeadCommunication,
  shouldAdvanceDeliveryState,
  splitQuotedEmailText,
  TRADE_EMAIL_MARK_PATH,
  TRADE_EMAIL_BODY_MAX,
  TRADE_EMAIL_PREVIEW_LENGTH,
  TRADE_EMAIL_RESEND_WINDOW_MS,
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

describe("retryWithinIdempotencyWindow", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("allows a resend when no attempt was ever made", () => {
    assert.strictEqual(retryWithinIdempotencyWindow(null, now), true);
  });

  it("allows a resend inside the provider idempotency window", () => {
    const recent = new Date(now.getTime() - 60_000);
    const edge = new Date(now.getTime() - TRADE_EMAIL_RESEND_WINDOW_MS);
    assert.strictEqual(retryWithinIdempotencyWindow(recent, now), true);
    assert.strictEqual(retryWithinIdempotencyWindow(edge, now), true);
  });

  it("refuses a resend once the key may have expired", () => {
    const stale = new Date(
      now.getTime() - TRADE_EMAIL_RESEND_WINDOW_MS - 60_000
    );
    assert.strictEqual(retryWithinIdempotencyWindow(stale, now), false);
    // And the constant stays inside Resend's 24h key retention.
    assert.ok(TRADE_EMAIL_RESEND_WINDOW_MS < 24 * 60 * 60 * 1000);
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

describe("buildTradeLeadOutboundHtml", () => {
  const html = buildTradeLeadOutboundHtml({
    bodyHtml: plainTextToHtml("Thanks for reaching out.\n\nPrice list attached."),
    markUrl: `https://deepdivebrewing.com${TRADE_EMAIL_MARK_PATH}`,
    siteUrl: "https://deepdivebrewing.com",
  });

  it("embeds the absolute brand-mark URL", () => {
    assert.ok(
      html.includes(`src="https://deepdivebrewing.com${TRADE_EMAIL_MARK_PATH}"`),
      "expected the hoppy turtle mark as an absolute URL"
    );
    assert.ok(html.includes('alt="Deep Dive Brewing Co"'));
  });

  it("renders the mark centered at the enlarged brand size", () => {
    assert.ok(html.includes('width="92"'));
    // Centered presentation: the cell aligns center and the image
    // carries an auto-margin fallback for clients that need it.
    assert.ok(html.includes("margin:0 auto"));
  });

  it("carries the staff body inside the card unchanged", () => {
    assert.ok(html.includes("<p>Thanks for reaching out.</p>"));
    assert.ok(html.includes("<p>Price list attached.</p>"));
  });

  it("has a brand footer with the site link", () => {
    assert.ok(html.includes("Deep Dive Brewing Co"));
    assert.ok(html.includes("Saba, Dutch Caribbean"));
    assert.ok(html.includes('href="https://deepdivebrewing.com"'));
    // No sender name passed — the footer falls back to the bare brand line.
    assert.ok(!html.includes("&middot; Deep Dive Brewing Co"));
  });

  it("credits the sending admin when a sender name is supplied", () => {
    const withSender = buildTradeLeadOutboundHtml({
      bodyHtml: "<p>hi</p>",
      markUrl: `https://deepdivebrewing.com${TRADE_EMAIL_MARK_PATH}`,
      siteUrl: "https://deepdivebrewing.com",
      senderName: "Chad",
    });
    assert.ok(withSender.includes("Chad &middot; Deep Dive Brewing Co"));
    // Blank or absent names fall back to the bare brand line.
    const blank = buildTradeLeadOutboundHtml({
      bodyHtml: "<p>hi</p>",
      markUrl: `https://deepdivebrewing.com${TRADE_EMAIL_MARK_PATH}`,
      siteUrl: "https://deepdivebrewing.com",
      senderName: "   ",
    });
    assert.ok(!blank.includes("&middot;"));
  });

  it("escapes the sender name — it cannot inject markup", () => {
    const evil = buildTradeLeadOutboundHtml({
      bodyHtml: "<p>hi</p>",
      markUrl: `https://deepdivebrewing.com${TRADE_EMAIL_MARK_PATH}`,
      siteUrl: "https://deepdivebrewing.com",
      senderName: 'Chad <img src=x onerror="alert(1)">',
    });
    assert.ok(!evil.includes("<img src=x"));
    assert.ok(evil.includes("Chad &lt;img"));
  });

  it("escapes the mark URL and keeps email-safe markup", () => {
    const evil = buildTradeLeadOutboundHtml({
      bodyHtml: "<p>x</p>",
      markUrl: 'https://x.test/"><script>alert(1)</script>',
      siteUrl: "https://deepdivebrewing.com",
    });
    assert.ok(!evil.includes("<script"));
    // Inline styles + tables only — no external fonts or scripts.
    assert.ok(!html.includes("@import") && !html.includes("<link"));
  });
});

describe("splitQuotedEmailText", () => {
  it("splits a reply above a '>' quoted block", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Yes, two cases works.\n\nOn Mon, Oct 6, Chad wrote:\n> here is the price list"
    );
    assert.strictEqual(fresh, "Yes, two cases works.");
    assert.ok(quoted?.includes("> here is the price list"));
  });

  it("splits an 'Original Message' separator", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Confirmed.\n\n-----Original Message-----\nFrom: Chad\nSent: Monday"
    );
    assert.strictEqual(fresh, "Confirmed.");
    assert.ok(quoted?.includes("Original Message"));
  });

  it("splits an Outlook From:/Sent: header block", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Sounds good.\n\nFrom: chad@deepdivebrewing.com\nSent: Monday\nTo: sam@harbour.example"
    );
    assert.strictEqual(fresh, "Sounds good.");
    assert.ok(quoted?.startsWith("From:"));
  });

  it("does not split a bare From: line that is not a header block", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Prices start From: $20 per case\n\nLet me know."
    );
    assert.strictEqual(quoted, null);
    assert.ok(fresh.includes("From: $20"));
  });

  it("splits a reply above a bare '>' quoted tail", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Done.\n\n> original question\n> second line"
    );
    assert.strictEqual(fresh, "Done.");
    assert.ok(quoted?.includes("> original question"));
  });

  it("keeps an interleaved reply expanded — post-quote text is new content", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Hi\n> Can you ship Monday?\nPlease ship Tuesday instead"
    );
    assert.strictEqual(quoted, null);
    assert.ok(fresh.includes("Please ship Tuesday instead"));
  });

  it("never hides the whole message — marker on line 0 keeps everything", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "> forwarded content only"
    );
    assert.strictEqual(quoted, null);
    assert.ok(fresh.includes("forwarded content only"));
  });

  it("returns the full body when nothing is quoted", () => {
    const { fresh, quoted } = splitQuotedEmailText(
      "Hello\n\nNo quotes here."
    );
    assert.strictEqual(quoted, null);
    assert.strictEqual(fresh, "Hello\n\nNo quotes here.");
  });
});
