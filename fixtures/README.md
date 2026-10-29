# Fixtures

Fake data for `npm run seed` and the tests. Times are relative to when the seed runs.

| File | What it has |
|---|---|
| `render-logs.json` | App log lines in the shapes the app's `lib/log.ts` writes, plus a duplicate line, a console-mailer line (dropped), an info line (ignored), an error message with secrets and PII (stored scrubbed) and a prompt-injection attempt (stored as data only). |
| `sentry-issues.json` | One issue matching a log error, which must join that incident, and one browser error only Sentry sees. |
| `health-series.json` | A cold-start series (no incident), an outage (critical app-down, then critical database-down, then recovery) and one deploy. |

`index.ts` loads them, and its `EXPECTED` list is what the pipeline must produce: 9 incidents with their kind, severity and event count. `tests/unit/seed-fixtures.test.ts` checks it in memory, and `tests/db/seed.test.ts` checks it against MySQL.

Seeded rows are marked `seeded = 1`, use their own fingerprint namespace and `seed:` settings, so they never merge with real incidents. Run `npm run seed` to reset and reseed, or `npm run seed -- --no-reset` to check that a second run stores nothing new.
