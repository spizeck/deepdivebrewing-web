# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public issue.**

Instead, contact us directly at the email address associated with this repository. We will acknowledge receipt within 48 hours and work to resolve the issue promptly.

## Supported Versions

Only the latest deployed version of this site is actively maintained.

## Scope

This policy covers:

- The Deep Dive Brewing Co website application
- Firebase security rules and configuration
- Environment variable handling
- Third-party dependency vulnerabilities

## Security Practices

### Environment Variables

- All Firebase credentials are stored in `.env.local` and never committed to version control.
- `.env.local` is listed in `.gitignore`.
- The `.env.local.example` file contains only placeholder keys with no real values.

### Firebase

- Firestore security rules restrict read/write access appropriately.
- Firebase Admin SDK service account keys (`*firebase-adminsdk*.json`) are excluded from version control via `.gitignore`.
- Client-side writes are limited to the trade lead inquiry form only.

### Dependencies

- Dependencies are reviewed and updated regularly.
- `npm audit` is run as part of routine maintenance.

### Deployment

- Production deployments are managed through Vercel.
- Environment variables are configured in the Vercel dashboard, not in source code.
