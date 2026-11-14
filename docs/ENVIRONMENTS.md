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
| URL | `localhost` | `https://edu-live-frontend-staging.buildminds-co-in.workers.dev` (Worker: `https://edu-live-worker-staging.buildminds-co-in.workers.dev`) | `https://edu-live-frontend.buildminds-co-in.workers.dev` |
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
  `light notes.pdf`, `life Processes notes.pdf`, `control coordination test.pdf`.
  Names must match exactly.
- **R2 holds three kinds of file**: source PDFs, `page-images/`, and
  `cleaned/`. The last two are rebuilt by ingestion, so they are never copied.

## Enforced in code

- The Worker's top level has no `account_id`, so a bare `wrangler deploy` can't
  reach the buildminds account. Prod is reachable only with `--env production`.
- Frontend pages pick their Worker from their own hostname
  (`frontend/env.js`). Staging pages can't reach prod, and unknown hosts get no
  backend. Non-prod pages show an orange banner.
- The eval harness (`worker/evals/run-evals.js`) requires a worker URL and
  refuses production unless `--allow-prod` is passed.
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

Apply the migration before deploying the code. The old code still runs on the
new schema, so this order is safe.

Restore a prod point if needed:
`npx wrangler d1 time-travel restore edu-live-db --env production --bookmark=<bookmark>`.
Time Travel covers about 7 days on the free plan.

## Release flow (summary)

- `feature/<name>` and `fix/<name>` branch from `staging`, merge back into
  `staging` through a PR with one approval.
- `staging` merges into `main` through a release PR, by buildminds only.
- `hotfix/<name>` branches from `main`, merges into `main`, and then `main` is
  merged back into `staging`.

## One-time setup (not yet done)

These steps need someone signed in to the right Cloudflare account. The
Cloudflare resources do not exist yet, so the staging deploy fails until they do.

1. **Sign in to the buildminds account** (`npx wrangler login` as
   buildminds.co.in@gmail.com). Staging resources go in this account, not a
   separate one. Note: members of this account can reach prod resources, so
   access is the buildminds team's call.
2. **In the buildminds account, create:**
   - `npx wrangler d1 create edu-live-db-staging`
   - `npx wrangler r2 bucket create edu-live-pdfs-staging`
   - `npx wrangler vectorize create edu-live-chunks-staging --dimensions=768 --metric=cosine`
3. **Fill in the placeholder:** `worker/wrangler.toml`,
   `[env.staging]` `database_id` = `REPLACE_WITH_STAGING_D1_ID`. The account ID
   is already set to the buildminds account.
4. **Migrate and set secrets in staging:**
   - `npm run db:migrate:staging`
   - `npx wrangler secret put OPENROUTER_API_KEY --env staging` (staging key, low limit)
   - `npx wrangler secret put ADMIN_API_KEY --env staging`
   - `npx wrangler secret put INGEST_API_KEY --env staging`
5. **Deploy staging:** `npm run deploy:staging`, then from `frontend/`:
   `npx wrangler deploy --env staging`
6. **Upload the four eval PDFs** from the master folder through the staging
   dashboard. Then set the staging worker URL for evals:
   `node evals/run-evals.js --worker-url=https://edu-live-worker-staging.buildminds-co-in.workers.dev`
7. **Local dev:** each developer runs `wrangler d1 create edu-live-db-dev`,
   `wrangler r2 bucket create edu-live-pdfs-dev`, and
   `wrangler vectorize create edu-live-chunks-dev --dimensions=768 --metric=cosine`
   in their own account, then pastes the D1 ID into `worker/wrangler.toml` (top
   level). Copy `worker/.dev.vars.example` to `worker/.dev.vars`.

## Open items

- `worker/test-fixtures/` contains committed PDFs. The rule is "one master copy",
  so these should move out of the repo once the master folder is set up.
- The git `staging` branch does not exist yet. It should be created from `main`
  once, by buildminds.
- The admin and ingest keys are still `<ADMIN_KEY>` in every environment. Rotate
  them before real use and move them out of the example file.
