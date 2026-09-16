# Contributing

This repository is the **production website and content-management
application for Deep Dive Brewing Co** — a real business, live at
<https://deepdivebrewing.com>. It is public for transparency and reference;
changes ship to a production site, so contributions should be focused,
reviewed, and verified.

## Prerequisites

- **Node.js** — the version in [`.nvmrc`](.nvmrc) is authoritative
  (`engines.node` in `package.json` matches). Use `nvm use` / `nvm install`
  or install Node 24.x manually.
- **npm** — the lockfile is `package-lock.json`; do not use pnpm or yarn.
- **Java 21+** — only needed for the Firebase emulator rules tests
  (`npm run test:rules`); everything else runs without it.
- Firebase and Vercel credentials are **not** required for the verification
  suite or `next build`. For local development with real data, see the
  README's [local setup](README.md#local-setup) and
  [environment variables](README.md#required-environment-variables).

## Getting started

```bash
npm ci        # clean install from the lockfile
npm run dev   # dev server → http://localhost:3000
```

## Workflow

1. Branch from current `main`; keep the branch focused on one change.
2. Make the smallest change that solves the problem and follow existing
   patterns. [docs/TECHNICAL.md](docs/TECHNICAL.md) is the architecture
   reference.
3. Update documentation when behavior, configuration, or architecture
   changes (`README.md`, `docs/`, `SECURITY.md` — whichever is authoritative).
4. Run the verification suite below.
5. Open a pull request against `main` and fill in the template.

## Verification

These are the same checks the required **Verify** CI job runs on every PR:

```bash
npm ci                       # clean install
npm run check:react-versions # react/react-dom declared versions must match
npx tsc --noEmit             # TypeScript
npm run lint                 # ESLint
npm test                     # node:test unit suite
npm run test:rules           # Firestore/Storage emulator rules tests (needs Java 21+)
npm run build                # production build (needs no env values)
npm run check:md-links       # relative Markdown links
```

## Pull requests and CI

- Keep PRs focused on a single change; describe *why* it is needed.
- Every PR runs the required **Verify** check and gets a Vercel preview
  deployment — check the preview for UI changes.
- All review conversations must be resolved before merge.
- PRs are squash-merged into `main`; merging deploys production.
- Dependabot PRs go through the same CI and review — no auto-merge.

## Security issues

**Do not open a public issue for a suspected vulnerability** — this is a
public repository and a public report discloses the issue before it can be
fixed. See [SECURITY.md](SECURITY.md) for the reporting process.

## For AI coding agents

[AGENTS.md](AGENTS.md) is the authoritative working guide for coding
agents. This file describes the shared contribution workflow; it applies
to agent-authored PRs as well.
