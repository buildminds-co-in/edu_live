# Release vX.Y.Z — YYYY-MM-DD

<!-- Copy to docs/releases/vX.Y.Z.md. Developers draft it during staging
     review; buildminds completes it at release and merges it in the same
     staging -> main release PR. -->

**Type:** patch | minor | major
**Released by:** buildminds
**Approved by:** <reviewer names>

## Changes
- <one line per change> (#<PR number>)

## Database migrations
- None | <migration file names>
- Backup taken: worker/backups/<file>.sql (`npm run db:backup:prod`)

## Config and secrets
- None | <dashboard Settings changed, secrets added or rotated>

## Staging verification
- Eval result: X/20 (report: worker/evals/results/<file>.json, model <slug>)
- Manual checks: <what was tested, by whom>

## Prod deployment
- Deployed with `npm run deploy:prod` from tag `vX.Y.Z` (Worker and frontend, both tagged `vX.Y.Z`, even if the frontend did not change)
- Worker version: <new id> (previous: <id>)
- Frontend version: <new id> (previous: <id>)
- `npx wrangler versions list --env production` shows tag `vX.Y.Z` in both worker/ and frontend/
- Smoke test: chat answers / `/admin/config` returns 401 without key / dashboard loads with key

## Rollback
- `npx wrangler rollback <previous id> --env production` (in worker/ and frontend/)
- Data: <restore steps if a migration ran, or "not needed">

## Known issues
- None | <list>
