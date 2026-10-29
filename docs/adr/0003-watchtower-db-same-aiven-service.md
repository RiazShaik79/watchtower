# ADR 0003: Watchtower DB on the same Aiven service, isolated database and user

- **Status:** Accepted, 2026-10-28
- **Owner's choice:** same service, chosen over a separate Aiven org

## Context
Incidents need durable storage. Aiven gives one free MySQL service per organization (1 GB disk, 76 connections) and may power off idle free services. The brief forbids Watchtower from using the app's production tables or credentials.

## Decision
- Create database `watchtower` and user `watchtower` on the existing Aiven service.
- Grant `ALL PRIVILEGES ON watchtower.*` and **nothing else**. There is no global grant and no access to the app's database.
- The **owner creates both by running `npm run db:setup` on their own laptop** (updated 2026-10-29). The script takes the Aiven admin Service URI as hidden input, keeps it in memory only, creates the database and user (generated password), runs the verification below, creates the tables and prints the new `WT_DATABASE_URL` once. A console-created Aiven user would get admin-level rights by default ([Aiven docs](https://aiven.io/docs/products/mysql/howto/manage-service-users)), which is why a script does it instead. Claude, the worker and the dashboard never see `avnadmin` or the app's `DATABASE_URL`.
- Watchtower's pool is capped at **3 connections**. The worker uses 1–2 and the dashboard 1–2.
- Raw events are purged after 14 days and incidents keep only scrubbed text. Target size is under 50 MB.
- TLS is verified with `rejectUnauthorized: true`, using `WT_DATABASE_CA_CERT`, the same pattern as the app's `lib/db.ts`.

## Verification (phase 2, step 1; automated by `db:setup`)
1. Aiven Free allows creating an extra database and user: the script fails clearly if not.
2. Connected as `watchtower`, `SHOW GRANTS` shows only `USAGE ON *.*` and `watchtower.*` (nothing WITH GRANT OPTION), and `SHOW DATABASES` lists only `watchtower` plus `information_schema`/`performance_schema`.
3. Reading the app's database (the admin URI's database, usually `defaultdb`) fails with access denied.

The same logic runs in CI against a MySQL container (`tests/db/setup.test.ts`), with the container set to Aiven's default `sql_mode` (`ANSI,…`).

Aiven's `ANSI` mode includes `ANSI_QUOTES`, so `SHOW GRANTS` writes names in double quotes, not backticks. The check accepts both (found on the first real run, 2026-10-29). All Watchtower SQL string literals use single quotes, so `ANSI_QUOTES` doesn't change how they're read.

If step 1 fails, fall back to a separate Aiven organization with its own free MySQL service.

## Consequences
- ✅ No new provider, and the same SQL dialect and patterns as the app.
- ❌ It shares disk and connections with production. A runaway Watchtower could affect the app, which the pool cap and purge job limit.
- ❌ `avnadmin`, used by the app, can still read the `watchtower` DB. That's acceptable because nothing there is sensitive after scrubbing.
