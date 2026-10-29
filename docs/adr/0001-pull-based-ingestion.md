# ADR 0001: Pull-based ingestion, no webhooks

- **Status:** Accepted, 2026-10-28
- **Deciders:** Owner, Claude

## Context
The obvious way to ingest signals is push: Sentry alert webhooks and Render deploy/failure webhooks. On our plans:
- Render webhooks require a **Pro** workspace.
- Sentry's Developer plan lists "API & third-party integrations" as Team-only. Whether internal-integration webhooks work on Developer is unconfirmed.
- The Watchtower dashboard runs on Render Free and sleeps. It takes about 1 minute to wake, so webhooks that arrive while it sleeps would time out and be lost.

## Decision
The worker **pulls** every signal on a schedule:
- **Render Logs API** (`GET /v1/logs`). This is the primary error and slow-query signal, and is why the app gets structured JSON logs in phase 1.
- **Render Deploys API**, for deploy detection and post-deploy verification.
- **App `/api/health`**, for availability and the DB check.
- **Sentry issues API**, optionally, and only if the phase-1 experiment shows it works on Developer.

Each source keeps a cursor in `settings`, uses an overlapping time window and dedupes on `(source, external_id)`.

## Consequences
- ✅ No paid plans needed, and no events lost while the dashboard sleeps.
- ✅ No inbound endpoint to secure or expose.
- ❌ Latency is about 15–30 minutes.
- ❌ It depends on the app logging errors in a parseable form, which phase 1 provides.
- Render keeps logs for 7 days on Hobby, so even a worker outage of several days loses no data.

## Revisit when
The plan moves to Render Pro or Sentry Team, or real-time alerting (phase 6) is needed.
