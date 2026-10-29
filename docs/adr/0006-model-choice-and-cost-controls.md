# ADR 0006: Model choice and cost controls

- **Status:** Accepted, 2026-10-28

## Context
Pricing per million tokens, checked 2026-10-28:

| Model | Input | Output | Cache hit |
|---|---|---|---|
| Sonnet 5.5 | $2 | $10 | $0.10 |
| Opus 5.5 | $4 | $20 | $0.20 |
| Haiku 5.5 | $0.10 | $0.50 | — |

The Start tier allows 1,000 RPM with a $500/month cap. New orgs may begin on the lower Evaluation tier.

## Decision
- **Diagnosis:** `claude-sonnet-5-5` (`ANTHROPIC_MODEL`). A manual "deep re-diagnose" button uses `claude-opus-5-5` (`ANTHROPIC_DEEP_MODEL`).
- **Fix runs:** Sonnet 5.5 via `claude-code-action`, `--model claude-sonnet-5-5`.
- **Prompt caching:** system instructions, the `CLAUDE.md` files and source files go in a cached prefix. The untrusted logs go last.
- **Controls:**
  - dedupe by fingerprint
  - cache diagnoses per `(fingerprint, input_hash)`
  - `DIAG_MAX_PER_HOUR=5`, `DIAG_MAX_PER_DAY=20`
  - `MONTHLY_API_BUDGET_USD=20`, after which diagnosis stops and the dashboard shows a banner
  - the kill switch
  - one fix dispatch per approval
- **Console setup:** a dedicated workspace "watchtower" with a $20/month spend limit, using the same key for the worker and the app-repo fix workflow.
- **Recording:** every call records its tokens and cost in `api_usage`. The dashboard shows the month-to-date figure.

## Estimates
- **Diagnosis:** about 25k tokens in (mostly cached after the first run) and 2k out, so **about $0.05–0.10**.
- **Fix run:** about 40 turns, plus three reviewer subagents, so **about $1–4**. CI minutes are free because the repo is public.
- **Monthly:** 10 incidents and 3 fixes comes to **under $15**.

## Key timing
The key is first needed at the **start of phase 3**. Phases 0–2 need no Anthropic key.
