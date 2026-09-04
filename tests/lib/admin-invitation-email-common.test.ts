import { describe, it } from "node:test";
import assert from "node:assert";
import { buildAdminInvitationEmail } from "@/lib/admin-invitation-email-common";

describe("buildAdminInvitationEmail", () => {
  const email = buildAdminInvitationEmail({
    to: "admin@example.com",
    from: "invitations@deepdivebrewing.com",
    role: "superadmin",
    adminUrl: "https://deepdivebrewing.com/admin",
  });

  it("uses the normalized invited address as the recipient", () => {
    assert.strictEqual(email.to, "admin@example.com");
  });

  it("uses the server-controlled sender address", () => {
    assert.strictEqual(email.from, "invitations@deepdivebrewing.com");
  });

  it("uses the server-controlled admin URL in the HTML", () => {
    assert.match(email.html, /https:\/\/deepdivebrewing\.com\/admin/);
  });

  it("includes the assigned role", () => {
    assert.match(email.html, /superadmin/);
    assert.match(email.text, /superadmin/);
  });

  it("includes Deep Dive Brewing Co branding", () => {
    assert.match(email.html, /Deep Dive Brewing Co/);
    assert.match(email.subject, /Deep Dive Brewing Co/);
  });

  it("mentions the exact invited Google account", () => {
    assert.match(email.html, /admin@example\.com/);
    assert.match(email.text, /admin@example\.com/);
  });

  it("states that access is not granted until the invitation is accepted", () => {
    assert.match(
      email.html,
      /access will not be granted until you accept/i
    );
    assert.match(
      email.text,
      /access will not be granted until you accept/i
    );
  });

  it("does not include a Firebase token, credential, or secret", () => {
    const combined = `${email.html}\n${email.text}\n${email.subject}`;
    assert.doesNotMatch(combined, /RESEND_API_KEY/);
    assert.doesNotMatch(combined, /FIREBASE_ADMIN_PRIVATE_KEY/);
    assert.doesNotMatch(combined, /BEGIN PRIVATE KEY/);
    assert.doesNotMatch(combined, /Bearer\s+[a-zA-Z0-9_-]+/);
    assert.doesNotMatch(combined, /idToken/);
    assert.doesNotMatch(combined, /customClaims/);
    assert.doesNotMatch(combined, /firebase.*app/);
  });

  it("includes a call-to-action button in the HTML", () => {
    assert.match(email.html, /<a[^>]+href=/);
  });
});
