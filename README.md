# Edukripa (Cloudflare)

A study assistant for class 10 (CBSE) science and maths students, built
entirely on Cloudflare (Workers, Vectorize, Workers AI, R2, D1, Browser
Rendering) with OpenRouter models. It has three student features, all
grounded in documents an admin uploads:

- **Chat**: answers questions from the uploaded notes and papers, with the
  source page shown under the answer.
- **Concept Explainer**: a structured explanation of one concept.
- **Question papers**: generates a paper and its answer key from chosen
  chapters, with PDF downloads.

Students use it on edukripa.com through an embedded widget, or on the
frontend site directly. An admin dashboard handles uploads, transactions,
costs and runtime settings.

## What's where

| Path | What it is |
|---|---|
| `worker/` | The API: one Cloudflare Worker (`edu-live-worker`). Ingestion, chat, explainer, question papers, admin routes. |
| `frontend/` | Static files served by a second Worker (`edu-live-frontend`): the student app (`index.html`), the admin dashboard (`dashboard.html`), the embeddable widget (`widget.js`) and `env.js`, which picks the right API for the environment. |
| `worker/evals/` | Manual eval suites run against a deployed Worker (`npm run eval:golden`, `npm run eval:client`). |
| `docs/` | `ENVIRONMENTS.md` (environments, data rules, release flow, deploys), `PROJECT_OVERVIEW.md` (business-level walkthrough), `releases/` (one note per release), `superpowers/` (design specs and plans). |
| `CLAUDE.md` | Architecture reference, kept current. Start here for how the code works. |
| `content/manifest.md` | Which PDFs exist and which environment needs them. The PDFs themselves are not in the repo. |

## Environments

| | Student app and dashboard | API |
|---|---|---|
| Prod | https://edu-live-frontend.buildminds-co-in.workers.dev (`/dashboard`) | https://edu-live-worker.buildminds-co-in.workers.dev |
| Staging | https://edu-live-frontend-staging.buildminds-co-in.workers.dev (`/dashboard`) | https://edu-live-worker-staging.buildminds-co-in.workers.dev |
| Local | `npx serve .` in `frontend/` | `wrangler dev` on localhost:8787 |

edukripa.com embeds the **prod** widget
(`https://edu-live-frontend.buildminds-co-in.workers.dev/widget.js`), so a
prod frontend deploy reaches students straight away.

Rules for data, accounts and migrations: `docs/ENVIRONMENTS.md`.

## Getting started (local dev)

```bash
cd worker
npm ci                                   # install exact dependencies (re-run after any dependency change)
cp .dev.vars.example .dev.vars           # then put your own OpenRouter key in it
npx wrangler login                       # your own Cloudflare account for local dev
npx wrangler dev --persist-to=.wrangler/state
```

Local dev needs its own D1, R2 and Vectorize resources in your account; the
one-time steps are in `docs/ENVIRONMENTS.md`. `wrangler dev` cannot emulate
Vectorize, Workers AI or Browser Rendering, so those always hit the real
(paid per use) services.

In a second terminal: `cd frontend && npx serve .`. On `localhost`,
`frontend/env.js` points the pages at `http://localhost:8787` and shows a
"LOCAL ENVIRONMENT" banner.

## Tests and evals

```bash
cd worker
npx vitest run       # unit tests (all bindings mocked)
npx tsc --noEmit     # type check (test/chat.test.ts has known mock-type errors)
npm run eval:golden -- --worker-url=<staging worker URL>
npm run eval:client -- --worker-url=<staging worker URL>   # needs the official PDFs in evals/reference-papers/
```

Evals make real model calls and cost OpenRouter credit. They refuse prod
unless `--allow-prod` is passed.

## Branches, releases and deploys

- `feature/<name>` or `fix/<name>` from `staging`, PR into `staging` (one
  approval), deploy staging, test.
- Release: `release/vX.Y.Z` PR into `main` (buildminds approves), tag
  `vX.Y.Z`, deploy prod from the tag, then merge `main` back into `staging`.
- Always merge PRs with **"Create a merge commit"**, never squash.
- Deploy with `npm run deploy:staging` or `npm run deploy:prod` from
  `worker/`. Each deploys the Worker **and** the frontend, both labelled with
  the same version. Prod deploys only from a clean release tag. Details and
  checks: `docs/ENVIRONMENTS.md`, "Deploys and version labels".
- Each release has a note in `docs/releases/` (copy `TEMPLATE.md`).
