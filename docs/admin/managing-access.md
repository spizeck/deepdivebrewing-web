# Managing Administrator Access

> **Warning:** Adding, removing, or changing administrator roles affects who can edit production content and who can manage access. Only superadmins should use this section.

## Roles

| Role | What it can do |
|---|---|
| **superadmin** | Manage beers and venues, manage all administrators, trigger rebuilds. |
| **admin** | Manage beers and venues, trigger rebuilds. Cannot manage other administrators. |

## How administrator access is stored

Authorization is based on **Firebase custom claims**. A valid admin token contains claims like:

```json
{
  "admin": true,
  "role": "superadmin"
}
```

The website also keeps a read-only record in Firestore under the `adminUsers` collection for display and audit purposes. The custom claim is what actually grants access; the Firestore record is for reference and must stay in sync with the claim.

## Bootstrap superadmin

When the website is first deployed, there are no administrators. One account is configured as the bootstrap superadmin through the server-only environment variable `SUPER_ADMIN_EMAIL`.

> The production value of `SUPER_ADMIN_EMAIL` must be set to `chadnuttall1@gmail.com`.

The bootstrap process:

1. The owner signs in to https://deepdivebrewing.com/admin with the configured Google account.
2. The dashboard shows **Complete Superadmin Setup** because the account has no admin claim yet.
3. The owner clicks the button. The server verifies the ID token email against `SUPER_ADMIN_EMAIL`, confirms the email is verified, and sets the superadmin custom claim.
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
3. Clicks **Accept Invitation** when prompted.
4. Signs out and signs back in.

> Invitations match the normalized email address exactly. The invited account must use that exact email and it must be verified by Google.

## Editing an administrator

In the **Access** tab, superadmins can:

- **Promote** an admin to superadmin.
- **Demote** a superadmin to admin (not allowed if it would remove the last active superadmin).
- **Disable** an administrator, which removes their custom claims and blocks access.
- **Reactivate** a disabled administrator, which restores their previous role claim.
- **Revoke** an administrator permanently, which disables the account and revokes refresh tokens.

> The bootstrap superadmin and the last active superadmin cannot be disabled, demoted, or revoked. This prevents accidental lockout.

## Why you may need to sign out and back in

Custom claims are baked into the Firebase ID token when it is issued. When a superadmin changes your role or reactivates your account, you must request a fresh token by signing out and signing back in. The dashboard will tell you when this is required.

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
