# Phase 3 setup: the owner's steps

Phase 3 lets Claude diagnose each new incident: it reads the errors and the app's code and writes down the likely cause and how to fix it. It's advice only. Nothing changes in the app, and fixes arrive in phase 4.

Never paste API keys or tokens into a chat with Claude. They only go into the website boxes named below.

| # | Where | What | Time |
|---|---|---|---|
| 1 | Anthropic Console | A key for Watchtower, with a $20/month spending limit | 5 min |
| 2 | GitHub (Watchtower repo) | Save the key as a secret | 2 min |
| 3 | GitHub (both repos) | Merge the two phase 3 pull requests | 2 min |
| 4 | Render + PowerShell | One test session with the 3 deliberate bugs, then switch them off | 15 min |

---

## 1. Anthropic Console: a key with a spending limit

Go to **https://console.anthropic.com** and sign in.

1. **Create a workspace for Watchtower:** **Settings** → **Workspaces** → **Create workspace** → name it `watchtower`.
2. **Set its spending limit:** open the `watchtower` workspace → **Limits** → set the **monthly spend limit** to **$20**. Anthropic stops the key there, whatever happens in Watchtower.
3. **Create the key inside that workspace:** **API keys** → **Create key** → workspace **watchtower** → name it `watchtower-worker` → **Create**. Copy the key (it starts with `sk-ant-`). It's shown only once.

Watchtower has its own limits as well: 5 diagnoses an hour, 20 a day, and a $20 monthly budget, after which it pauses itself. A diagnosis costs about $0.05–0.10.

## 2. GitHub: save the key

Go to **https://github.com/RiazShaik79/watchtower** → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab → **New repository secret**:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the key from step 1.3 |

That's the only new setting. Leave the optional variables (`DIAG_MAX_PER_HOUR`, `DIAG_MAX_PER_DAY`, `MONTHLY_API_BUDGET_USD`, `ANTHROPIC_MODEL`) unset to keep the defaults. If you change `MONTHLY_API_BUDGET_USD`, add the same value on the Render dashboard service too, so its banner uses the same figure.

**Don't** add the key to Render. Only the worker uses it; the dashboard never does.

## 3. Merge the two pull requests

1. **Watchtower repo:** the phase 3 pull request (diagnosis) → **Merge pull request** → **Confirm merge**. Render redeploys the dashboard by itself.
2. **Place-and-Plate repo:** https://github.com/RiazShaik79/Place-and-Plate/pull/2 (chaos scenarios, **off by default**) → **Merge pull request** → **Confirm merge**. Render redeploys the app by itself.

Then check the worker: **Watchtower repo** → **Actions** → **worker** → **Run workflow**. It should go green. Tell Claude when it has finished, and Claude will read the run's summary (it contains no secrets).

## 4. Test session: three deliberate bugs

The app now contains three small, deliberate bugs behind a lock with two keys. Each is reachable only when both keys are set. This session turns them on, triggers each once, lets Watchtower diagnose them, and turns them off again. They never touch any user data.

1. **Make a test token** in PowerShell:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Copy the line it prints.
2. **On the Render website:** open the **Place-and-Plate** service (the app, not watchtower) → **Environment** → add both, then **Save changes**. The app restarts in about 2 minutes.

   | Name | Value |
   |---|---|
   | `CHAOS_MODE` | `enabled` |
   | `CHAOS_TOKEN` | the line from step 4.1 |

3. **Trigger the three bugs** in PowerShell. Replace `PASTE-TOKEN-HERE` with the same token:
   ```
   $t = "PASTE-TOKEN-HERE"
   foreach ($s in "null-handling","bad-sql","db-timeout") {
     try { Invoke-WebRequest "https://place-and-plate.onrender.com/api/chaos/$s" -Headers @{ "x-chaos-token" = $t } -UseBasicParsing | Out-Null; "$s -> 200 (unexpected)" }
     catch { "$s -> $($_.Exception.Response.StatusCode.value__)" }
   }
   ```
   You should see `500` three times: each bug fired. `404` means chaos mode isn't on yet (wait a minute and retry) or the token doesn't match.
4. **Wait 2 minutes**, so the errors reach Render's logs. Then **Watchtower repo** → **Actions** → **worker** → **Run workflow**.
5. **Open the dashboard.** There's a red "CHAOS MODE IS ON" banner and three new incidents, one per bug. Open each one: the **Diagnosis** section should name the cause. If a diagnosis isn't there yet, run the worker once more; it does at most 3 per run.
6. **Switch chaos off:** Render → **Place-and-Plate** → **Environment** → delete `CHAOS_MODE` and `CHAOS_TOKEN` → **Save changes**. The banner goes away after the next worker run.

Tell Claude what the three diagnoses say, or just "done", and Claude will check them against the known causes.

## The kill switch

The dashboard's home page has a **Kill switch: Turn on** button. While it's on, Watchtower makes no Claude calls at all. Each switch is recorded in the audit trail.
