# ADR 0002: GitHub Actions worker plus a sleeping dashboard

- **Status:** Accepted, 2026-10-28. Reconfirmed 2026-10-29: an hourly alternative was withdrawn ([ADR 0008](0008-hourly-cadence.md)).

## Context
- Render Free spins down after 15 minutes with no inbound traffic.
- Each workspace has **750 free instance-hours a month, shared** by all Free services. If they run out, **every** Free service, including the app, is suspended until the 1st.
- A 30-day month has 720 h, so an always-on Free Watchtower plus an app that health polling keeps awake would go over the limit.
- The owner chose a $0 setup over Render Starter ($7/month).

## Decision
- **Worker**: a scheduled GitHub Actions workflow in this repo.
  - Cron runs at `7,22,37,52 * * * *` (off the top of the hour, when GitHub drops jobs under load).
  - It also has `workflow_dispatch` for "Run worker now".
  - Each run does one tick and exits. It uses no Render hours.
- **Dashboard**: a Render Free web service. It sleeps when idle and wakes when the owner opens it.
- **App health cadence**: every 15 min during active hours (`POLL_ACTIVE_HOURS`, default 07–23 Asia/Kolkata) and hourly overnight. The app sleeps overnight, keeping it to about 500–550 h a month.
- The **Watchtower repo should be public** for unlimited Actions minutes. If it stays private (2,000 min/month), use a 30-minute cadence.
- A scheduled workflow is disabled after **60 days** with no repo activity, so the worker writes a keep-alive audit entry and the dashboard warns when the last tick is over 45 minutes old.

## Consequences
- ✅ $0. Render hours stay within budget, and the dashboard shows an estimate.
- ✅ The worker never holds an inbound port. Secrets live in Actions secrets.
- ❌ GitHub cron is best effort: runs can be delayed or dropped. The dashboard shows a "stale worker" banner.
- ❌ Health checks are coarse (15 min). A short outage between polls can be missed, but Render's own health check and auto-restart still protect the app.

## Alternatives rejected
- **Render Starter $7/month**: the most reliable option, but the owner prefers $0. It's the first upgrade to make if the cron proves unreliable.
- **An external cron keeping a Free Watchtower awake**: blows the shared hours budget.
