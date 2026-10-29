# ADR 0003: Watchtower DB on the same Aiven service, isolated database and user

- **Status:** Accepted, 2026-10-28
- **Owner's choice:** same service, chosen over a separate Aiven org

## Context
Incidents need durable storage. Aiven gives one free MySQL service per organization (1 GB disk, 76 connections) and may power off idle free services. The brief forbids Watchtower from using the app's production tables or credentials.

## Decision
- Create database `watchtower` and user `watchtower` on the existing Aiven service.
- Grant `ALL PRIVILEGES ON watchtower.*` and **nothing else**. There is no global grant and no access to the app's database.
- The **owner creates both in the Aiven console**. Claude and Watchtower never see `avnadmin` or the app's `DATABASE_URL`.
- Watchtower's pool is capped at **3 connections**. The worker uses 1–2 and the dashboard 1–2.
- Raw events are purged after 14 days and incidents keep only scrubbed text. Target size is under 50 MB.
- TLS is verified with `rejectUnauthorized: true`, using `WT_DATABASE_CA_CERT`, the same pattern as the app's `lib/db.ts`.

## Verification (phase 2, step 1)
1. Confirm that Aiven Free allows creating an extra database and user.
2. Connected as `watchtower`, `SHOW DATABASES` must list only `watchtower` and `information_schema`.
3. A test query against an app table must fail with access denied.

If step 1 fails, fall back to a separate Aiven organization with its own free MySQL service.

## Consequences
- ✅ No new provider, and the same SQL dialect and patterns as the app.
- ❌ It shares disk and connections with production. A runaway Watchtower could affect the app, which the pool cap and purge job limit.
- ❌ `avnadmin`, used by the app, can still read the `watchtower` DB. That's acceptable because nothing there is sensitive after scrubbing.
