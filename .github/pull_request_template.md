## Summary

<!-- What changed and why? -->

Closes #

## Changes

-
-

## Verification

<!-- The same checks the Verify CI job runs — see CONTRIBUTING.md. -->

- [ ] `npm ci`
- [ ] `npm run check:react-versions`
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:rules` (needs Java 21+)
- [ ] `npm run build`
- [ ] `npm run check:md-links`
- [ ] Vercel preview reviewed (for UI changes)

## Risk / deployment notes

<!-- Migrations, environment variables, Firebase rules, external services,
production behavior, security implications. Delete this section if none. -->

- [ ] No secrets, credentials, or private data were committed.
- [ ] If `firestore.rules` or `storage.rules` changed, the applicable
  rules target was deployed before merge. Vercel does not deploy
  Firebase resources.
- [ ] If `firestore.indexes.json` changed,
  `firebase deploy --only firestore:indexes` was run before merge and
  the required index is READY. A merged query without its index fails
  with `FAILED_PRECONDITION`.
