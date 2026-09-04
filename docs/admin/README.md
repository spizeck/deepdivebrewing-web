# Administrator Handbook

This guide is for the staff and owners who keep the Deep Dive Brewing Co website up to date.

> **Warning:** The admin dashboard edits **production content**. Changes you save are visible to customers as soon as the public pages refresh or are rebuilt. Always double-check your work before saving.

## What the admin area controls

The admin dashboard lets authorized users:

- View, create, and edit beer records.
- View, create, and edit venue/partner records.
- Upload beer card and hero images to Firebase Storage.
- Trigger a site rebuild so static pages (such as the beer listing and Where to Buy page) show the latest content.

In addition, users with the **superadmin** role can:

- Invite, edit, disable, reactivate, and revoke other administrators.
- View pending invitations and administrator audit logs in Firestore.

The dashboard does **not** let you delete beer or venue records directly. To remove something from public view, uncheck the **Public** checkbox and save.

## Who should have access

Only a small set of trusted Deep Dive Brewing Co staff should be administrators. There are two roles:

- **superadmin** — Full access, including the ability to manage other administrators.
- **admin** — Can manage beers, venues, images, and trigger rebuilds, but cannot add or remove administrators.

Access is granted through **Firebase custom claims** and stored in the `adminUsers` Firestore collection. The claims are the authoritative source of authorization; the UI simply hides controls that a user is not allowed to use.

## How to reach the admin login

1. Go to https://deepdivebrewing.com/admin.
2. Click **Sign in with Google**.
3. Choose the Google account that has been invited or configured as the bootstrap superadmin.
4. If your account has the right claims, the full dashboard appears.

> The first time the bootstrap superadmin signs in, they must click **Complete Superadmin Setup**. This is a one-time step.

## What a successful login looks like

After signing in, the dashboard shows:

- Your email address at the top.
- A **Rebuild Site** button.
- The last rebuild information.
- Tabs for **Beers**, **Venues**, and, if you are a superadmin, **Access**.

If you see a message saying your account is not authorized, you are signed in to Google but do not have valid admin claims. Sign out and contact a superadmin.

## How to sign out

Click the **Sign out** button in the top-right area of the dashboard. After signing out, you return to the sign-in screen.

## How to request access

If you need admin access:

1. Make sure you have a Google account you can use.
2. Ask an existing superadmin to invite your email address from the **Access** tab.
3. Once the invitation is created, sign in at https://deepdivebrewing.com/admin with that Google account.
4. Click **Accept Invitation** when prompted, then sign out and sign back in.

## Recommended browser and troubleshooting

- Use a modern browser such as Chrome, Edge, Firefox, or Safari.
- Enable cookies and local storage for `deepdivebrewing.com`.
- Allow popups from `deepdivebrewing.com` so the Google sign-in popup can open.
- Disable ad blockers or privacy extensions temporarily if sign-in fails.
- If you see a blank page or login loop, clear cookies for the site and try again.

For detailed login troubleshooting, see [Login and access](./login-and-access.md).

## Task-specific guides

- [Login and access](./login-and-access.md)
- [Managing access](./managing-access.md)
- [Managing beers](./managing-beers.md)
- [Managing locations](./managing-locations.md)
- [Images and storage](./images-and-storage.md)
- [Trade inquiries](./trade-inquiries.md)
