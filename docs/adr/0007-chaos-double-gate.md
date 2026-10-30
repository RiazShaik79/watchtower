# ADR 0007: Chaos injection double-gate

- **Status:** Accepted, 2026-10-28

## Context
End-to-end tests (diagnosis in phase 3, fix → deploy → verify in phase 5) need real, known bugs in the deployed app. The app has only one environment, which is production on Render Free. Seeded fake incidents (`npm run seed`) cover everything up to diagnosis without touching the app.

## Decision
Add a `lib/chaos.ts` module plus `app/api/chaos/[scenario]/route.ts` in the app. They are added in phase 3, in their own PR. A scenario runs only when **all** of these are true:
1. The env var `CHAOS_MODE` equals exactly `enabled`. It is unset by default and not in `render.yaml`.
2. The request carries header `x-chaos-token` matching `CHAOS_TOKEN`, compared in constant time. `CHAOS_TOKEN` must be at least 32 characters.
3. The scenario is in a hard-coded allowlist: `null-handling`, `bad-sql`, `db-timeout`.

In every other case the route returns **404**, exactly like a missing route.

Further rules:
- When `CHAOS_MODE=enabled`, every request logs `{"level":"warn","msg":"CHAOS MODE ENABLED"}`, and `/api/health` reports `chaos: true`. Watchtower shows a red banner while it is on.
- Chaos never touches real data. `bad-sql` runs a malformed read-only query, and `db-timeout` uses `SELECT SLEEP(n)` with a short timeout.
- The fix workflow's path guard forbids changing `lib/chaos.ts`. Seeded bugs are fixed in a deliberately seeded call site, not by deleting chaos.

## As built (phase 3, 2026-10-30)
- **Gate:** `lib/chaos.ts`, pure and unit-tested.
- **Seeded bugs:** `lib/chaos-cases.ts` holds the call sites a fix may edit, plus two read-only helpers in the app's `lib/db.ts`, the only database module there:
  - `null-handling`: an unchecked `Map` lookup (`!`) for a meal that isn't in the table
  - `bad-sql`: `SELECT NOW() … FROM DUAL WHERE`, a syntax error
  - `db-timeout`: `SELECT SLEEP(3)` raced against a 1 s limit
- **"Every request logs" became "every chaos request logs".** The warning is logged on each `/api/chaos/*` request while the mode is on. Logging it on *every* request would need middleware, and Render's frequent health checks would flood the logs that Watchtower reads. `/api/health` still reports `chaos: true`, and the Watchtower worker turns that into the dashboard banner (`app_chaos` setting).

## Consequences
- ✅ It can't be enabled by accident: it needs an env change plus a secret header.
- ❌ It runs in production, so the owner turns it off after each test session. The dashboard banner is the reminder.
