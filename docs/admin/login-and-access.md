# Login and Access

This guide explains how to sign in to the Deep Dive Brewing Co admin dashboard, how authorization is decided, and how to fix common login problems.

## Before you start

- Use a modern browser.
- Make sure popups are allowed for `deepdivebrewing.com`.
- Make sure cookies and third-party storage are not blocked.
- Have the Google account ready that an owner has added to the admin allow-list.

## Signing in

1. Open https://deepdivebrewing.com/admin.
2. Click **Sign in with Google**.
3. A Google popup appears. Choose the authorized Google account.
4. The popup closes and the dashboard loads.

If you are already signed in to Google with only one account, the popup may skip the account chooser and sign you in immediately.

## What happens after you choose an account

- The site verifies your Google ID token.
- It checks whether your email address is in the admin allow-list.
- If you are authorized, the dashboard loads beer and venue data from Firestore.
- If you are not authorized, you see a message such as `your-email@example.com is not authorized for admin access` and a **Sign out** button.

## How administrator authorization is determined

Authorization is controlled by an allow-list of email addresses.

- The same list is used in two places:
  - The React admin dashboard code (`lib/admin-emails.ts`) checks it on the client for UI gating.
  - The server-side API route and Firebase Security Rules also enforce it for any data changes or rebuilds.
- If the lists are out of sync, a user might see the dashboard but be unable to save data or trigger a rebuild.

## How an owner safely grants or removes access

> **Warning:** Changing access requires editing code and redeploying Firebase rules. Only an owner or developer should do this.

To grant access:

1. Add the email address to `lib/admin-emails.ts`.
2. Add the same email address to the allow-list in `firestore.rules`.
3. Add the same email address to the allow-list in `storage.rules`.
4. Redeploy the Firebase rules to the Firebase project.
5. Rebuild and redeploy the website so the updated `lib/admin-emails.ts` is included.
6. Ask the new admin to sign in at https://deepdivebrewing.com/admin.

To remove access, reverse the steps: remove the email from all three files, redeploy the rules, and rebuild the site.

## Firebase Authentication authorized domains

Firebase Authentication only allows sign-in from registered domains. The production domain `deepdivebrewing.com` and any Vercel preview domains must be listed in the Firebase Authentication console under **Settings > Authorized domains**.

If a new preview domain is not authorized, Google sign-in will fail with an `auth/unauthorized-domain` error. Add the exact domain to the Firebase console and try again.

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

**Symptom:** The dashboard says your email is signed in but is not authorized.

**Likely cause:** Your email is not in `lib/admin-emails.ts`, `firestore.rules`, and `storage.rules`.

**Fix:**

- Ask an owner to add your email to all three files, redeploy the rules, and rebuild the site.

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
