# ADR 0005: Manual rollback in v1

- **Status:** Accepted, 2026-10-28

## Context
- Render has a rollback API, and Free supports rollback to the two previous deploys.
- Render API keys are full workspace access, and they can read service env vars, including the app's Aiven `DATABASE_URL`. Scoped keys are early access, by request only.
- An API rollback does **not** turn off auto-deploy, so the next push would undo it. A dashboard rollback does turn it off.

## Decision
- Watchtower **never calls the rollback API** in v1.
- "Recommend rollback" shows:
  - the target deploy (ID, commit, time)
  - the exact Render dashboard steps
  - a reminder to re-enable auto-deploy after the fix
- The owner records the rollback with a click (`regression → rolled_back`).
- `RENDER_API_KEY` is held **only** as an Actions secret in this repo. It's used by the worker for `GET` logs and deploys, never exposed to PR-triggered workflows, prompts, logs or the DB. The worker's Render client allows **only GET requests**.
- The owner requests scoped-key early access. When a read-only key is available, swap it in. Automated rollback needs its own ADR.

## Consequences
- ✅ No automated path can roll back production, and the powerful key is confined.
- ❌ It's slower to mitigate, which is acceptable for a single-owner hobby app.
