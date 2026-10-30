# Watchtower — Plan & status

We stop for the owner's review after every phase. A ✋ marks a step the owner does by hand. These steps involve accounts, secrets or visibility changes, which Claude doesn't do.

## Phase 0: Report, architecture, plan ✅ (awaiting review)
- [x] Step-zero research → [docs/limitations-and-decisions.md](docs/limitations-and-decisions.md)
- [x] Architecture, data model, state machine → [docs/architecture.md](docs/architecture.md)
- [x] ADRs 0001–0007 → [docs/adr/](docs/adr/)
- [x] `CLAUDE.md`, `.env.example`, `.gitignore`, `git init`
- **Open questions, with the defaults we'll use unless you say otherwise:**
  - Watchtower repo visibility [public]
  - Active hours: **07–23 Asia/Kolkata, confirmed 2026-10-29.** Every 15 min in active hours, hourly overnight. A flat 15 min would risk suspension; the hourly-all-day idea was withdrawn ([ADR 0008](docs/adr/0008-hourly-cadence.md)).
  - Repo access for Claude [install `gh` and run `gh auth login`]
  - Request Render scoped-key early access [yes]

## Phase 1: App readiness PR (`RiazShaik79/Place-and-Plate`, branch `chore/watchtower-readiness`): ✅ done 2026-10-29
- [x] ✋ Give Claude access: `gh` is authenticated. Claude's working clone is `C:\dev\Place-and-Plate`; the owner's is the `Testing` folder.
- [x] Read the real `CLAUDE.md` files, `lib/db.ts` and the test runner, and check the brief's facts.
- [x] `app/api/health/route.ts`:
  - no auth
  - `pingDb(3000)` through `lib/db.ts`
  - returns `{status, db, db_ms, version, uptime_s}`, with no-store and no secrets
  - responds 503 when the DB is down
- [x] `lib/log.ts`: JSON lines. `instrumentation.ts` `onRequestError` logs `request_failed` for every route, so no route needed its own handling.
- [x] Slow-query (`SLOW_QUERY_MS`, default 1000) and DB-failure logging in `lib/db.ts`, with the SQL text only and no parameters.
- [x] Sentry, written by hand (no wizard):
  - `lib/sentry-scrub.ts` in `beforeSend`/`beforeBreadcrumb`
  - `dataCollection` with user info off
  - `tracesSampleRate` 0.05, no Replay
  - off when no DSN is set
  - `@sentry/nextjs` pinned to 11.7.0
- [x] `.github/workflows/ci.yml`:
  - `ci`: MySQL 8.4 service, typecheck, `test:quick`
  - `e2e`: runs on `fix/**` branches and on dispatch
- [x] Tests for health, the debug route, the logger and the scrubbing. The app's docs are updated.
- [x] Security fix in the same PR: `next` 16.4.0 → 16.4.3 (two critical RCE advisories). `npm audit` reports 0.
- [x] PR #1 is merged and live on Render, release `55bb45c`.
- [x] ✋ gitleaks 8.30.1 found no leaks in 3 commits. **The repo is public.**
- [x] ✋ Sentry: org `rles`, project `place-and-plate`, **EU region** (`de.sentry.io`). The vars are set on Render. The Health Check Path setting exists on Free and is set to `/api/health`.
- [x] ✋ Branch protection on `main`:
  - a PR is required, with **0** approvals, because GitHub won't let the owner approve their own PR
  - required check `ci`
  - **no bypass, admins included**
  - no force pushes or deletion
- [x] ✋ Sentry API experiment with a personal token (Project: Read, Issue & Event: Read): **200**. A Sentry poller is possible on Developer.
- **Done when:** met.
  - The deliberate error appeared in Sentry (Users 0, so no PII) **and** as a `request_failed` JSON line in the Render logs.
  - CI was green.
  - `/api/health` returns 200 `{"status":"ok","db":"up"}`.
- **Owner's leftovers in `Testing`:**
  - delete `.env.sentry-build-plugin` and the 2 empty `sentry-example-*` folders
  - `git stash drop`, which holds the wizard output
  - unset `DEBUG_ERROR_TOKEN` on Render if it's still set

## Phase 2: Ingestion, grouping, read-only dashboard
- [ ] ✋ Create the Aiven database `watchtower` and user `watchtower` (grants on `watchtower.*` only), then run the isolation checks in ADR 0003. Steps: `docs/setup-phase-2.md`.
- [x] Scaffold Next.js 16.4.3, React 19.3, TypeScript 7 strict (erasable-only), Tailwind v4, `mysql2`, `node:test`. No `tsx`: Node 24 strips types; `scripts/register.mjs` resolves imports. Versions pinned to the app's.
- [x] `db/migrations/001_init.sql` with all tables from architecture §3 (one open incident per fingerprint via a generated unique column; `dispatch_fix` needs an approval via a CHECK), plus the migration runner.
- [x] `lib/scrub.ts`, `lib/fingerprint.ts`, `lib/parse.ts`, `lib/severity.ts`, `lib/cadence.ts`, `lib/pipeline.ts`, `lib/audit.ts`, `lib/integrations/{render,sentry,app}.ts` (GET only).
- [x] `worker/tick.ts`: health (if due) → logs → Sentry → deploys → purge; each step fails safe. `.github/workflows/worker.yml` (cron `7,22,37,52`, dispatch, monthly keep-alive).
- [x] Dashboard: login (scrypt hash, HMAC'd DB session, httpOnly SameSite=Strict cookie, throttle), incident list, incident detail, worker-staleness banner, free-hours estimate, kill-switch state, API cost.
- [x] `npm run seed` with fixtures: Render log lines (incl. secrets, mailer line, prompt injection), Sentry issues, cold-start and outage health series, a deploy.
- [x] Tests (95 unit + DB suite in CI): scrubbing, fingerprint normalisation, parsing, grouping and dedupe, severity (cold start isn't critical), health, cadence/free hours, auth, seed fixtures end to end.
- [ ] ✋ Create the Watchtower GitHub repo, add the Actions secrets and variables, and create the Render Free service for the dashboard. Steps: `docs/setup-phase-2.md`.
- **Done when:** seeded incidents appear correctly grouped and with the right severity. ✅ In memory (`tests/unit/seed-fixtures.test.ts`); against MySQL in CI (`tests/db/seed.test.ts`); then on the live dashboard after setup.

## Phase 3: Diagnosis agent (✋ **create the Anthropic API key at the start of this phase**)
- [x] `lib/integrations/github.ts`: read-only file tree, files and commits at the live commit (`live_commit`, from the newest live deploy), with the worker job's own `github.token`. Files are chosen from the route, stack traces and their imports, plus the `CLAUDE.md` chain.
- [x] `lib/diagnose.ts`:
  - prompt builder: cached instructions and app source, then the incident's events inside `<untrusted_log_data>` with `< > & "` escaped
  - `lib/diagnosis-schema.ts`: closed JSON schema (structured outputs) and `validateDiagnosis`, which rejects extra fields and any citation that wasn't supplied
  - cache per incident, input hash and model
  - kill switch, `DIAG_MAX_PER_HOUR`, `DIAG_MAX_PER_DAY` and `MONTHLY_API_BUDGET_USD`, checked at the call site
  - `api_usage` and audit rows for every call
- [x] `lib/state-machine.ts`: the full transition table; phase 3 only moves incidents into `diagnosed`.
- [x] Re-diagnose, with notes and with the deep model: the dashboard queues an `approvals(rediagnose)` row and the next worker run picks it up (no dispatch token needed yet). Kill-switch toggle, budget banner and chaos banner on the dashboard.
- [x] Prompt-injection tests: the seeded line stays escaped data inside the untrusted block; an answer that obeys it is rejected; a valid answer only moves the incident to `diagnosed`.
- [ ] App PR adding the chaos module with 3 seeded bugs, per ADR 0007.
- [ ] ✋ Owner: Anthropic key, merge both PRs, one chaos test session. Steps: `docs/setup-phase-3.md`.
- **Done when:** all 3 seeded bugs are diagnosed with the correct root cause.

## Phase 4: Fix workflow
- [ ] App repo: `.claude/agents/qa-tester.md`, `code-reviewer.md`, `security-reviewer.md`, plus `.github/workflows/incident-fix.yml`:
  - App token
  - `claude-code-action@v1`
  - inputs passed through `env:`
  - path guard
  - PR template
- [ ] Watchtower: `lib/state-machine.ts`, Approve → `dispatchFix()`, PR and check sync, Dismiss, Recommend rollback.
- [ ] Tests:
  - a fix can't be dispatched without an approval row
  - one dispatch per approval
  - the kill switch blocks dispatch
  - illegal transitions throw
- [ ] ✋ Create the `watchtower-fixer` GitHub App (install it on the app repo only), add the app-repo secrets, and create the dispatch PAT.
- **Done when:** a seeded bug produces a correct PR that has passed review, with a regression test that fails before the fix.

## Phase 5: Verification & postmortems
- [ ] Deploy detection, the 30-minute awake-time window, `verified` or `regression`, the rollback recommendation and the postmortem.
- **Done when:** a merged fix is verified automatically on the dashboard.

## Phase 6 (later): Real-time alerts by email or Slack
