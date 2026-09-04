# Administrator Handbook

This guide is for the staff and owners who keep the Deep Dive Brewing Co website up to date.

> **Warning:** The admin dashboard edits **production content**. Changes you save are visible to customers as soon as the public pages refresh or are rebuilt. Always double-check your work before saving.

## What the admin area controls

The admin dashboard lets authorized users:

- View, create, and edit beer records.
- View, create, and edit venue/partner records.
- Upload beer card and hero images to Firebase Storage.
- Trigger a site rebuild so static pages (such as the beer listing and Where to Buy page) show the latest content.

It does **not** currently let you delete beer or venue records directly. To remove something from public view, uncheck the **Public** checkbox and save.

## Who should have access

Only a small set of trusted Deep Dive Brewing Co staff should be admins. Access is granted through an email allow-list stored in the codebase and in Firebase Security Rules. If someone needs access, an existing owner must add their Google email to both places and redeploy the rules. See [Login and access](./login-and-access.md#how-owner-grants-or-removes-access) for the exact steps.

## How to reach the admin login

1. Go to https://deepdivebrewing.com/admin.
2. You will see a sign-in screen with a **Sign in with Google** button.
3. Click the button and choose your authorized Google account.
4. If the account is on the allow-list, the full dashboard appears.

## What a successful login looks like

After signing in, the dashboard shows:

- Your email address at the top.
- A **Rebuild Site** button.
- The last rebuild information.
- Two tabs: **Beers** and **Venues**.

If you see a message saying your email is not authorized, you are signed in to Google but not on the allow-list. Sign out and contact an owner.

## How to sign out

Click the **Sign out** button in the top-right area of the dashboard. After signing out, you return to the sign-in screen.

## How to request access

If you need admin access:

1. Make sure you have a Google account you can use.
2. Ask an existing owner to add your email address to the admin allow-list. The owner will update `lib/admin-emails.ts`, `firestore.rules`, and `storage.rules`, then redeploy the rules.
3. Once that is done, sign in at https://deepdivebrewing.com/admin.

## Recommended browser and troubleshooting

- Use a modern browser such as Chrome, Edge, Firefox, or Safari.
- Enable cookies and local storage for `deepdivebrewing.com`.
- Allow popups from `deepdivebrewing.com` so the Google sign-in popup can open.
- Disable ad blockers or privacy extensions temporarily if sign-in fails.
- If you see a blank page or login loop, clear cookies for the site and try again.

For detailed login troubleshooting, see [Login and access](./login-and-access.md).

## Task-specific guides

- [Login and access](./login-and-access.md)
- [Managing beers](./managing-beers.md)
- [Managing locations](./managing-locations.md)
- [Images and storage](./images-and-storage.md)
- [Trade inquiries](./trade-inquiries.md)
