# Managing Administrator Access

> **Warning:** Adding, removing, or changing administrator roles affects who can edit production content and who can manage access. Only superadmins should use this section.

## Roles

| Role | What it can do |
|---|---|
| **superadmin** | Manage beers and venues, manage all administrators, trigger rebuilds. |
| **admin** | Manage beers and venues, trigger rebuilds. Cannot manage other administrators. |

## How administrator access is enforced

Privileged access requires **two things to agree**, and neither alone is
sufficient:

1. **Firebase custom claims** on the signed-in user's ID token. A valid
   admin token contains claims like:

   ```json
   {
     "admin": true,
     "role": "superadmin"
   }
   ```

2. **An `adminUsers/{uid}` record** in Firestore for the same user that
   exists, has `status: "active"`, and carries the same `role` as the
   claims.

Every privileged API request re-checks both on the server, and the
Firestore and Storage security rules apply the same check to the
dashboard's direct client reads and writes. The `adminUsers` record is
**not** reference-only data — it is half of the authorization check.

### Why both exist

Claims are baked into the ID token when it is issued, so a token can keep
asserting an old role until it is refreshed. The `adminUsers` record is
read live on every privileged request, which is what makes disabling,
demoting, or revoking an administrator take effect immediately: a stale
token whose claims no longer match the record is denied, even though the
claims themselves are still "valid."

Two lifecycle routes are deliberate exceptions to the
pre-existing-record requirement because their job is to create that
record:

- **Bootstrap** (`/api/admin/bootstrap`) — creates the first superadmin
  record; gated by a verified Google email matching the server-only
  `SUPER_ADMIN_EMAIL` variable instead.
- **Invitation acceptance** (`/api/admin/invitations/accept`) — creates
  the invited user's record and sets claims; gated by a pending
  invitation matching the verified sign-in email.

These are lifecycle-specific authorization flows, not bypasses — each has
its own enforced gate.

## Bootstrap superadmin

When the website is first deployed, there are no administrators. One account is configured as the bootstrap superadmin through the server-only environment variable `SUPER_ADMIN_EMAIL`.

> The production value of `SUPER_ADMIN_EMAIL` must be set to `chadnuttall1@gmail.com`.

The bootstrap process:

1. The owner signs in to https://deepdivebrewing.com/admin with the configured Google account.
2. The dashboard shows **Complete Superadmin Setup** because the account has no admin claim yet.
3. The owner clicks the button. The server verifies the ID token email against `SUPER_ADMIN_EMAIL`, confirms the email is verified, sets the superadmin custom claim, and creates the `adminUsers` record as an active superadmin.
4. The owner signs out and signs back in to refresh the ID token. The full dashboard now appears.

The bootstrap superadmin account is protected. It cannot be demoted, disabled, or revoked through the admin interface.

## Inviting a new administrator

1. Sign in as a superadmin.
2. Go to the **Access** tab.
3. Enter the new person's email address.
4. Choose a role (**admin** or **superadmin**).
5. Click **Invite**.

The system creates a pending invitation. The invited person then:

1. Opens https://deepdivebrewing.com/admin.
2. Signs in with the invited Google account.
3. Clicks **Accept Invitation** when prompted. Acceptance creates their `adminUsers` record and sets their custom claims to the invited role.
4. Signs out and signs back in.

> Invitations match the normalized email address exactly. The invited account must use that exact email and it must be verified by Google.

## Editing an administrator

In the **Access** tab, superadmins can:

- **Promote** an admin to superadmin.
- **Demote** a superadmin to admin (not allowed if it would remove the last active superadmin). The `adminUsers` record and the custom claim are updated together; the demoted person's old token is denied as soon as the record changes, even before they re-sign in.
- **Disable** an administrator, which clears their custom claims and marks the `adminUsers` record disabled. Access stops immediately — a still-unexpired token is denied because the record is no longer active.
- **Reactivate** a disabled administrator, which restores their previous role claim and marks the record active again.
- **Revoke** an administrator permanently, which clears their custom claims, revokes their refresh tokens, and marks the record disabled.

> The bootstrap superadmin and the last active superadmin cannot be disabled, demoted, or revoked. This prevents accidental lockout.

## Why you may need to sign out and back in

Custom claims are baked into the Firebase ID token when it is issued. When a superadmin changes your role, disables you, or reactivates your account, the server updates your claims and your `adminUsers` record right away — but your browser keeps the old token until it is refreshed.

The live-record check means enforcement does not wait for that refresh: a token whose claims no longer match the record is denied immediately. Signing out and back in simply gives you a fresh token whose claims agree with the record again, so the dashboard can load. The dashboard will tell you when this is required.

## Emergency recovery

If all superadmin accounts become inaccessible:

1. A developer with access to the Firebase project and Vercel environment variables must run the bootstrap migration script from a secure environment:
   ```bash
   npm run bootstrap-superadmin
   ```
2. The affected user signs out and signs back in at https://deepdivebrewing.com/admin.

See the [deployment guide](../operations/deployment.md) for details on running the migration safely.

## Audit logs

Every access-management action is recorded in the `adminAuditLogs` Firestore collection. Superadmins cannot edit or delete these records through the website. They include:

- The action performed (bootstrap, invite, update, revoke, etc.).
- The target account.
- The old and new role/status, if applicable.
- The acting administrator.
- A server timestamp.
