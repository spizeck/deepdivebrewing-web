# Login and Access

This guide explains how to sign in to the Deep Dive Brewing Co admin dashboard, how authorization is decided, and how to fix common login problems.

## Before you start

- Use a modern browser.
- Make sure popups are allowed for `deepdivebrewing.com`.
- Make sure cookies and third-party storage are not blocked.
- Have the Google account ready that has been invited by a superadmin, or the configured bootstrap superadmin account.

## Signing in

1. Open https://deepdivebrewing.com/admin.
2. Click **Sign in with Google**.
3. A Google popup appears. Choose the authorized Google account.
4. The popup closes and the dashboard loads.

If you are the bootstrap superadmin and it is your first sign-in, the dashboard shows **Complete Superadmin Setup**. Click it, then sign out and sign back in.

If you were invited but have not accepted the invitation yet, the dashboard shows **Accept Invitation**. Click it, then sign out and sign back in.

## What happens after you choose an account

- The site verifies your Google ID token with the Firebase Admin SDK.
- The server reads your Firebase custom claims. A valid admin has claims like `{ admin: true, role: "superadmin" }` or `{ admin: true, role: "admin" }`.
- If your claims are valid and your `adminUsers` record is active, the dashboard loads.
- If you are signed in but have no admin claim, the server checks whether your account matches the configured bootstrap superadmin email and offers the setup step if appropriate.
- If you are signed in but not authorized, you see a message saying your account is not authorized.

## How administrator authorization is determined

Authorization is controlled by **Firebase custom claims** set by the server. The server uses the Firebase Admin SDK to set claims after verifying:

- The user signed in with Google.
- The email is verified.
- For invitations, the email matches a pending invitation exactly.
- For the bootstrap flow, the email matches the server-only `SUPER_ADMIN_EMAIL` environment variable.

The client UI checks claims to decide which tabs and buttons to show, but the **server APIs and Firebase Security Rules enforce the real authorization**.

## Roles

- **superadmin** — Can manage content, administrators, and site rebuilds.
- **admin** — Can manage content and trigger rebuilds, but cannot open the **Access** tab or call access-management APIs.

## How a superadmin grants or removes access

> **Warning:** Granting superadmin access gives full control over the website and other administrators. Only invite people you trust.

To grant access:

1. Sign in as a superadmin.
2. Open the **Access** tab.
3. Enter the email address and choose a role.
4. Click **Invite**.
5. Tell the invited person to sign in with that exact Google account and accept the invitation.

To remove access:

1. Open the **Access** tab.
2. Find the administrator.
3. Click **Disable** to temporarily block access, or **Revoke** to permanently remove access.

The bootstrap superadmin account cannot be disabled or revoked through the UI. This prevents accidental lockout.

## Firebase Authentication authorized domains

Firebase Authentication only allows sign-in from registered domains. The production domain `deepdivebrewing.com` and any Vercel preview domains must be listed in the Firebase Authentication console under **Settings > Authorized domains**.

If a new preview domain is not authorized, Google sign-in will fail. Add the exact domain to the Firebase console and try again.

## Required CSP origins for Firebase Auth

The site uses a Content Security Policy (CSP) to protect visitors. Firebase Auth needs the following origins to be permitted:

- `connect-src` — `https://*.googleapis.com`, `https://*.firebaseio.com`, `https://accounts.google.com`, `https://apis.google.com`
- `frame-src` — `https://accounts.google.com` and the Firebase Auth helper iframe origin

The Firebase Auth helper domain currently used by the project is:

```
https://deepdivebrewing-web.firebaseapp.com
```

This domain is derived from the `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` environment variable at build time. It must remain permitted by the site's `frame-src` CSP while it is used as the Firebase `authDomain`.

## Popup, cookie, and privacy-browser considerations

- **Popup blockers** can prevent the Google sign-in window from opening. Allow popups for `deepdivebrewing.com`.
- **Strict privacy browsers or containers** may block the Firebase Auth helper iframe. If this happens, sign-in may fail even though the button is visible.
- **Third-party cookie blocking** in some browsers can interfere with the Google Identity Services flow.

## Signing out

Click the **Sign out** button in the dashboard header. This signs you out of Firebase Auth on the site. It does not sign you out of Google entirely.

## Claim refresh

Custom claims are embedded in the Firebase ID token. If a superadmin changes your role, disables your account, or reactivates it, you must sign out and sign back in to get a fresh token. The dashboard will prompt you to do this when needed.

## Troubleshooting

### `auth/popup-closed-by-user`

**Symptom:** You clicked **Sign in with Google**, but the popup closed before finishing.

**Likely causes:**

- You closed the popup yourself.
- A popup blocker closed it.
- The browser refused the popup.

**Fix:**

1. Allow popups for `deepdivebrewing.com`.
2. Try signing in again.
3. If the popup still closes, open the browser console and report any red error messages to the developer.

### Firebase Auth iframe blocked by CSP

**Symptom:** The sign-in button is visible, but after clicking it nothing happens, or the browser console shows a `frame-src` violation for `deepdivebrewing-web.firebaseapp.com`.

**Likely cause:** The Content-Security-Policy header does not permit the Firebase Auth helper iframe origin.

**Fix:**

- The `frame-src` directive in `next.config.ts` must include the value of `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` as an `https://` origin.
- If the environment variable changes, the site must be rebuilt and redeployed.
- Do not change the policy to `https://*.firebaseapp.com`; keep the exact origin.

### `auth/unauthorized-domain`

**Symptom:** A Firebase error says the domain is not authorized.

**Likely cause:** The current domain (production or a Vercel preview) is not in Firebase Authentication authorized domains.

**Fix:**

1. Open the Firebase Authentication console.
2. Go to **Settings > Authorized domains**.
3. Add the exact domain shown in the browser address bar.
4. Try signing in again.

### Popup blocked

**Symptom:** The browser shows a warning that a popup was blocked.

**Fix:**

- Allow popups for `deepdivebrewing.com`.
- Temporarily disable popup blockers or privacy extensions for this site.

### Wrong Google account

**Symptom:** You signed in but see an unauthorized email address.

**Fix:**

1. Click **Sign out**.
2. Sign in again and choose the correct Google account.
3. If you are signed in to multiple Google accounts, you may need to sign out of Google entirely or use an incognito/private window.

### Authenticated but not authorized

**Symptom:** The dashboard says your email is signed in but is not authorized, or you accepted an invitation but still see the unauthorized screen.

**Likely causes:**

- Your custom claim has not been refreshed after a role change or invitation acceptance.
- Your account is disabled.
- You signed in with a different email than the one that was invited.

**Fix:**

1. Sign out and sign back in to refresh your ID token.
2. Confirm you are using the exact invited email address.
3. Ask a superadmin to check your status in the **Access** tab.

### Expired session

**Symptom:** You were logged in before, but now the dashboard shows the sign-in screen.

**Likely cause:** Firebase Auth sessions can expire, especially after long periods of inactivity or password changes.

**Fix:**

1. Click **Sign in with Google** again.
2. If the issue repeats, clear cookies for `deepdivebrewing.com` and sign in fresh.

### Repeated login loop

**Symptom:** You keep returning to the sign-in screen after successfully signing in.

**Likely causes:**

- Third-party cookies or storage are blocked.
- The Firebase Auth helper iframe is being blocked.
- A privacy extension is interfering.

**Fix:**

1. Disable privacy extensions for `deepdivebrewing.com`.
2. Allow third-party cookies and storage.
3. Try a different browser or an incognito/private window.
4. Check the browser console for CSP errors.

## Need more help?

If none of these steps resolve the issue, contact the site developer or owner with:

- The exact URL you are visiting.
- The Google account email you are using.
- Any messages shown on screen.
- Any red errors in the browser console.
