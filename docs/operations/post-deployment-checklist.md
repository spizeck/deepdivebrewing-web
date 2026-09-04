# Post-Deployment Checklist

Run this checklist after every production deployment or after any significant content change.

## Homepage

- [ ] `https://deepdivebrewing.com/` loads without errors.
- [ ] The hero image or video renders correctly.
- [ ] The main heading and call-to-action buttons are visible.
- [ ] The "Book a Brewery Tour" WhatsApp link works and is tracked as `tour_inquiry_click`.
- [ ] The featured beers section shows the expected beers.
- [ ] The "Where to Find Us" section and link to `/where-to-buy` work.

## Beer listing

- [ ] `https://deepdivebrewing.com/beers` loads.
- [ ] The filter buttons (All, Core, Seasonal, Limited) work.
- [ ] Each beer card shows the correct name, style, ABV, status, and image.
- [ ] Clicking a beer card opens the correct detail page.
- [ ] New beers added since the last build are visible.

## Representative beer pages

- [ ] Visit at least one Core and one Seasonal/Limited beer detail page.
- [ ] The hero image loads.
- [ ] The title, style, ABV, status, description, and tasting notes are correct.
- [ ] The "Where to Buy" link works.
- [ ] Product structured data is present in the page source (search for `"@type":"Product"`).

## Where-to-buy page

- [ ] `https://deepdivebrewing.com/where-to-buy` loads.
- [ ] Venues are grouped under the expected region headings.
- [ ] Each venue card shows the name, type, public notes, and beer availability.
- [ ] Directions links open correctly.
- [ ] Website and social links open correctly.

## Contact map

- [ ] `https://deepdivebrewing.com/contact` loads.
- [ ] The Google Maps embed renders and shows the brewery location.
- [ ] WhatsApp, email, hours, and address information are correct.

## Admin login

- [ ] `https://deepdivebrewing.com/admin` shows the sign-in button.
- [ ] Clicking **Sign in with Google** opens the Google popup without CSP errors.
- [ ] An authorized account reaches the dashboard.
- [ ] No `frame-src` or `connect-src` CSP violations appear in the console.

## Trade page

- [ ] `https://deepdivebrewing.com/trade` loads.
- [ ] The inquiry form displays all required fields.
- [ ] Submitting the form (with a test address in a safe environment) returns a success message.
- [ ] The honeypot field is hidden.

## Firebase images

- [ ] Beer card images load on `/beers`.
- [ ] Beer hero images load on beer detail pages.
- [ ] No `img-src` CSP violations appear.
- [ ] No 402, 403, or 502 errors from `firebasestorage.googleapis.com` or `/_next/image`.

## Mobile layouts

- [ ] Repeat the homepage, beer listing, beer detail, where-to-buy, and contact checks on a mobile viewport (or mobile device).
- [ ] The navigation menu opens and closes correctly.
- [ ] No horizontal overflow is visible.
- [ ] Touch targets are large enough to tap easily.

## Redirects

- [ ] `http://deepdivebrewing.com` redirects to `https://deepdivebrewing.com` with a 308.
- [ ] `http://www.deepdivebrewing.com` redirects to `https://deepdivebrewing.com` with a 308.
- [ ] `https://www.deepdivebrewing.com` redirects to `https://deepdivebrewing.com` with a 308.

## Metadata and structured data

- [ ] The homepage `<title>` and meta description look correct.
- [ ] Beer detail pages have unique titles and descriptions.
- [ ] Each page has a canonical URL.
- [ ] Brewery structured data is present on the homepage and contact page.
- [ ] Product structured data is present on beer detail pages.

## Analytics

- [ ] Google Analytics 4 and Vercel Analytics scripts load on deployed URLs.
- [ ] Events such as `where_to_buy_click`, `directions_click`, `tour_inquiry_click`, `trade_form_start`, and `trade_form_success` fire when expected.
- [ ] No personal information is sent with analytics events.

## Browser console

- [ ] Open the browser console on the homepage, `/beers`, a beer detail page, `/where-to-buy`, `/contact`, and `/admin`.
- [ ] Look for CSP violations, 4xx/5xx errors, or JavaScript exceptions.
- [ ] Ignore expected local-only messages such as Vercel Analytics 404s when running `npm run start` locally.

## Response headers

- [ ] Check that the `Content-Security-Policy` header is present.
- [ ] Confirm `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` are present.
- [ ] Verify the `frame-src` directive includes the current Firebase Auth origin.

## 404 behavior

- [ ] Visit a non-existent page such as `https://deepdivebrewing.com/this-page-does-not-exist`.
- [ ] Confirm the site returns a styled 404 page.
- [ ] Confirm the HTTP status is 404.

## Final steps

- [ ] Note the production deployment URL and commit SHA.
- [ ] Confirm the Vercel deployment status shows "Ready."
- [ ] Communicate the deployment status to the team.
- [ ] Keep a brief record of what was changed and any issues found.

## Need help?

If any check fails, see the [Troubleshooting Guide](./troubleshooting.md) or contact the site developer with the failing URL and any browser console errors.
