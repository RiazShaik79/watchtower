# ADR 0004: `workflow_dispatch` plus a dedicated GitHub App for fixes

- **Status:** Accepted, 2026-10-28

## Context
After approval, Watchtower must start a fix run in the app repo, and that run must be able to open a PR that triggers CI. Constraints:
- `repository_dispatch` needs a token with **Contents: write**. That is enough to push code, which is too much for Watchtower.
- `workflow_dispatch` needs **Actions: write** (per third-party sources; verified in phase 4). That lets Watchtower start workflows but not change code.
- PRs opened with the workflow's `GITHUB_TOKEN` **do not trigger** other workflows, so CI wouldn't run.
- Branch protection becomes free once the app repo is public.

## Decision
- **The dashboard** dispatches `incident-fix.yml` using a fine-grained PAT. It covers the app repo only, with Actions RW, Contents R and Metadata R, and expires after 90 days.
- **The fix workflow** authenticates to GitHub as a dedicated GitHub App, `watchtower-fixer`. It has Contents RW and Pull requests RW, is installed on the app repo only, and its token is minted per run with `actions/create-github-app-token` and passed to `claude-code-action` as `github_token`.
- **Branch protection on `main`:**
  - require a PR
  - require 1 approval
  - require status check `ci`
  - dismiss stale approvals
  - admin bypass stays **on**, so the owner's own build workflow keeps working
- The App isn't an admin, so it can't push to `main`, approve its own PR or merge. **Only the owner merges.**
- Workflow inputs (`incident_id`, `diagnosis` as base64 JSON, `watchtower_url`) are read via `env:` and written to files. They are never interpolated with `${{ }}` into `run:` lines, which prevents script injection.

## Consequences
- ✅ No token anywhere can merge. Watchtower can't write code, and the fixer can't reach `main`.
- ❌ There are two credentials to rotate: the PAT, which expires, and the App key. The dashboard warns 14 days before the PAT expires.
