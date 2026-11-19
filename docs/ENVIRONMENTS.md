# Environments

Three environments. Prod holds real student data and is treated as production.

| | Local dev | Staging (review) | Prod |
|---|---|---|---|
| Who | Jameel and Naveed, each on their own | Both developers deploy; reviewers test | buildminds only |
| Cloudflare account | Each developer's personal account | **Buildminds account (same as prod, for now)**. Both developers become members of this account, which is a change from the original plan. | buildminds.co.in (only member: buildminds) |
| Wrangler target | `npm run dev` (no `--env`) | `--env staging` | `--env production` |
| Worker / frontend | `wrangler dev` on localhost:8787 + `npx serve` | `edu-live-worker-staging` / `edu-live-frontend-staging` | `edu-live-worker` / `edu-live-frontend` |
| D1 database | Local file (`edu-live-db-dev`) | `edu-live-db-staging` | `edu-live-db` |
| R2 bucket | Local file (`edu-live-pdfs-dev`) | `edu-live-pdfs-staging` | `edu-live-pdfs` |
| Vectorize index | `edu-live-chunks-dev` in your own account (cannot run locally) | `edu-live-chunks-staging` | `edu-live-chunks` |
| OpenRouter key | Your own key, in `worker/.dev.vars` | Staging key, low spending limit | Prod key, its own spending limit |
| Admin and ingest keys | `<ADMIN_KEY>` for now | `<ADMIN_KEY>` for now | `<ADMIN_KEY>` for now (rotate before real use) |
| URL | `localhost` | `https://edu-live-frontend-staging.buildminds-co-in.workers.dev` (Worker: `https://edu-live-worker-staging.buildminds-co-in.workers.dev`) | `https://edu-live-frontend.buildminds-co-in.workers.dev` (Worker: `https://edu-live-worker.buildminds-co-in.workers.dev`) |
| Embedded on | none | none (test the widget on the staging dashboard) | **edukripa.com** loads the prod `widget.js`, so a prod frontend deploy reaches students immediately (`widget.js` is served with `max-age=0`) |
| Domain (later) | none | `staging.<domain>` behind Cloudflare Access (free) | `<domain>` and `api.<domain>` |

Every Vectorize index is 768 dimensions with cosine metric, matching
`@cf/baai/bge-base-en-v1.5`. Changing the embedding model means a new index
and re-ingesting every PDF.

## Data rules

- **Prod data never leaves prod.** The only content that moves between
  environments is the PDFs, and every environment ingests them fresh from the
  master folder (see `content/manifest.md`).
- **No prod data in staging or dev.** Don't copy the prod D1 database, R2
  bucket, or Vectorize index anywhere.
- **The `transactions` table is never exported** to another environment or to
  a laptop. It holds real questions from 16-17 year old students.
- **One master copy of the PDFs**, in the shared buildminds-owned Drive folder.
- **Staging holds the eval PDFs**: `carbon compound notes.pdf`,
  `light notes.pdf`, `life Processes notes.pdf`, `control coordination test.pdf`
  (golden suite), and the four Edukripa sample papers and keys (client suite).
  Names must match exactly.
- **The client eval suite also reads the official papers locally**: put the
  four `Edukripa_*.pdf` files in `worker/evals/reference-papers/` (gitignored,
  never committed).
- **R2 holds three kinds of file**: source PDFs, `page-images/`, and
  `cleaned/`. The last two are rebuilt by ingestion, so they are never copied.

## Enforced in code

- The Worker's top level has no `account_id`, so a bare `wrangler deploy` can't
  reach the buildminds account. Prod is reachable only with `--env production`.
- Frontend pages pick their Worker from their own hostname
  (`frontend/env.js`). Staging pages can't reach prod, and unknown hosts get no
  backend. Non-prod pages show an orange banner.
- The eval harness (`worker/evals/run-evals.js`, `npm run eval:golden` /
  `npm run eval:client`) requires a worker URL and refuses production unless
  `--allow-prod` is passed. The client suite stops before any paid call if an
  official PDF is missing.
- `npm run deploy:prod` refuses unless the checkout is exactly on a release tag
  with no uncommitted changes (see "Deploys and version labels").
- `npm run db:check` fails if a new migration drops or renames anything.
- `npm run db:backup:prod` records a D1 Time Travel restore point for prod.
  It writes no data to disk.

## Migrations

Migrations only add things. Add tables and columns. Never rename or drop in
the same release as the code that relies on them.

Order for every migration:

1. `npm run db:check` (must pass)
2. For prod: `npm run db:backup:prod` (must print a restore point)
3. Apply the migration: `npm run db:migrate:staging`, then later
   `npm run db:migrate:prod`
4. Deploy the code: `npm run deploy:staging`, then later `npm run deploy:prod`
   (each deploys the Worker and the frontend; see "Deploys and version labels")

Apply the migration before deploying the code. The old code still runs on the
new schema, so this order is safe.

Restore a prod point if needed:
`npx wrangler d1 time-travel restore edu-live-db --env production --bookmark=<bookmark>`.
Time Travel covers about 7 days on the free plan.

## Release flow

- `feature/<name>` and `fix/<name>` branch from `staging`, merge back into
  `staging` through a PR with one approval. Then `npm run deploy:staging` and
  test on staging.
- `hotfix/<name>` branches from `main`, merges into `main`, and then `main` is
  merged back into `staging`.
- **Every PR is merged with "Create a merge commit"**, never squash. Squashing
  leaves commits and release tags out of the other branch's history, so the
  next release PR shows already-shipped work as new and conflicts (this
  happened with PRs #10 and #18; v1.1.7 repaired it).
- A PR author can't approve their own PR: approval comes from buildminds or
  Jameel.

Releasing `staging` to prod (as done for v1.1.7):

1. Branch `release/vX.Y.Z` from `staging`. Add `docs/releases/vX.Y.Z.md`
   from `TEMPLATE.md` (changes, migrations, staging verification, rollback
   IDs = the current prod versions).
2. Check it merges cleanly into `main`:
   `git merge-tree --write-tree origin/main HEAD`. If it conflicts, merge
   `origin/main` into the release branch first and resolve there.
3. PR `release/vX.Y.Z` into `main`; buildminds approves and merges (merge
   commit).
4. Tag the merge commit: `git tag -a vX.Y.Z origin/main -m "Release vX.Y.Z"`,
   `git push origin vX.Y.Z`.
5. If there is a migration: `npm run db:backup:prod`, then
   `npm run db:migrate:prod`.
6. `git switch --detach vX.Y.Z`, `npm ci`, `npx vitest run`, then
   `npm run deploy:prod` (from `worker/`). Run by a person: Claude Code's auto
   mode blocks prod deploys.
7. Smoke test prod: app, dashboard, `/question-paper/catalog`, `/chat`
   answers with a source, `/admin/config` returns 401 without the key, and
   the change itself.
8. Branch `merge/main-into-staging-vX.Y.Z` from `main`, fill in the prod
   section of the release note, PR into `staging` (merge commit). Then
   `npm run deploy:staging` so staging shows `vX.Y.Z+<commit>`.

## Deploys and version labels

Every deploy ships the Worker **and** the frontend together, labelled with the
same version, so you can always tell what is running:

- `npm run deploy:staging` / `npm run deploy:prod` (from `worker/`) run
  `worker/scripts/deploy.js`, which deploys the Worker, then the frontend, both
  with `--tag <version>` and `--message "<version> <env> @ <commit>"`.
- The version is the release tag when the checkout is exactly on one (`v1.1.6`),
  otherwise the newest release tag plus the commit (`v1.1.6+39a34a9`), with
  `-dirty` added for uncommitted changes.
- **Prod refuses to deploy** unless the checkout is exactly on a release tag
  with no uncommitted changes: `git switch --detach vX.Y.Z` first.
- The frontend is deployed even when it has not changed. Wrangler then uploads
  no files and only records a new version with the same tag. This is what keeps
  the two in step.
- Check what is live: `npx wrangler versions list --env production` in
  `worker/` and in `frontend/`. The newest `Tag` in each must match.
- Don't run `npx wrangler deploy --env ...` by hand for staging or prod; it
  skips the tag and deploys only one of the two.

## One-time setup

**Staging and prod are set up** (in the buildminds account, signed in as
buildminds.co.in@gmail.com; members of this account can reach prod resources,
so access is the buildminds team's call). The `staging` git branch exists.

**Local dev, per developer**, in your own Cloudflare account:

1. `npx wrangler d1 create edu-live-db-dev`,
   `npx wrangler r2 bucket create edu-live-pdfs-dev`,
   `npx wrangler vectorize create edu-live-chunks-dev --dimensions=768 --metric=cosine`.
2. Paste the D1 ID into `worker/wrangler.toml` (top level).
3. Copy `worker/.dev.vars.example` to `worker/.dev.vars` and add your own
   OpenRouter key.
4. `npm ci` in `worker/`, then `npm run db:migrate:dev`.

If staging ever has to be rebuilt: create `edu-live-db-staging`,
`edu-live-pdfs-staging` and `edu-live-chunks-staging` (768, cosine) in the
buildminds account, put the D1 ID in `[env.staging]`, run
`npm run db:migrate:staging`, set the three secrets with `--env staging`,
`npm run deploy:staging`, and upload the eval PDFs through the staging
dashboard.

## Open items

- `worker/test-fixtures/` contains committed PDFs. The rule is "one master copy",
  so these should move out of the repo (keep `test-fixtures/enrichment/` and
  `test-fixtures/question-paper/`, which are regression fixtures).
- `content/manifest.md` still needs the link to the master Drive folder.
- The admin and ingest keys are still a shared placeholder in every
  environment. Rotate them before real use and move them out of the example
  file.
