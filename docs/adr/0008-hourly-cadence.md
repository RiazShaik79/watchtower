# ADR 0008: Hourly worker cadence

- **Status:** Withdrawn, 2026-10-29. The cadence stays as decided in [ADR 0002](0002-actions-worker-and-sleeping-dashboard.md).

## What was proposed
Run the worker hourly, all day, because Watchtower is a learning project.

## Why it was withdrawn
The owner asked to keep 15-minute checks as long as they cause no harm. ADR 0002's split does that:
- every 15 minutes from 07:00 to 23:00 Asia/Kolkata
- hourly overnight

That's about 500–550 Render free hours a month against the shared 750.

A flat 15-minute cadence all day would **not** be safe. It would keep the app awake about 730 h a month, and with the dashboard on top it could exhaust the shared allowance and suspend every Free service, including the app.

## Still useful if the cadence changes later
If a slower cadence is ever wanted, the rules need adjusting together:
- critical should be judged within one tick (3 attempts, 60 s apart), not across ticks
- rates should be counted per hour
- the stale banner should fire after about 2.5 × the interval
- verification should happen on the next tick
