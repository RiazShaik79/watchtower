# Phase 2 setup: the owner's steps

The code is done and tested. To make Watchtower run for real, you need to do three things in three websites. Never paste passwords, tokens or keys into a chat with Claude. They only go into the website boxes named below.

| # | Where | What | Time |
|---|---|---|---|
| 1 | Aiven + a MySQL client | Create Watchtower's own database and user | 10 min |
| 2 | GitHub (Watchtower repo) | Add the secrets and settings the 15-minute worker needs | 10 min |
| 3 | Render | Create the dashboard website (Free, sleeps when idle) | 10 min |

---

## 1. Aiven: Watchtower's own database and user

Watchtower gets its **own** database and its **own** user, which can't see your app's data (ADR 0003).

1. Connect to your Aiven MySQL as the admin user (`avnadmin`), the same way you ran the app's database setup before (MySQL Workbench or the `mysql` command). The connection details are on the Aiven service's **Overview** page.
2. Make up a strong password for the new user, for example from a password manager. Then run:
   ```sql
   CREATE DATABASE watchtower CHARACTER SET utf8mb4;
   CREATE USER 'watchtower'@'%' IDENTIFIED BY 'PUT-THE-NEW-PASSWORD-HERE';
   GRANT ALL PRIVILEGES ON watchtower.* TO 'watchtower'@'%';
   SHOW GRANTS FOR 'watchtower'@'%';
   ```
   The last line should show `USAGE ON *.*` and `ALL PRIVILEGES ON watchtower.*`, and **nothing else**.
3. **Isolation check.** Disconnect, then connect again as `watchtower` with the new password and run:
   ```sql
   SHOW DATABASES;
   ```
   You should see only `watchtower` plus MySQL's built-in `information_schema` (and possibly `performance_schema`). Then try reading your app's data, using your app's database name (often `defaultdb`):
   ```sql
   SELECT COUNT(*) FROM defaultdb.users;
   ```
   It must fail with **access denied**. If it doesn't, stop and tell Claude.
4. **Build the connection string** for later (keep it in Notepad for now; don't save the file):
   ```
   mysql://watchtower:PASSWORD@HOST:PORT/watchtower?ssl-mode=REQUIRED
   ```
   `HOST` and `PORT` are the same as your app's. If the password contains `@ : / # %` or spaces, URL-encode them (`@` becomes `%40`, for example).
   You'll also need the **CA certificate**. It's the same one your app uses (`DATABASE_CA_CERT` on Render), or Aiven → Overview → **CA certificate** → Download.

## 2. GitHub: the worker's settings

Claude creates the Watchtower repo for you (public, so GitHub Actions minutes are free). Then go to **https://github.com/RiazShaik79/watchtower → Settings → Secrets and variables → Actions**.

**Secrets tab → New repository secret.** Secrets are hidden once saved.

| Name | Value |
|---|---|
| `WT_DATABASE_URL` | the connection string from step 1.4 |
| `WT_DATABASE_CA_CERT` | the whole CA certificate text, including the `BEGIN`/`END` lines |
| `RENDER_API_KEY` | Render → your avatar (top right) → **Account settings** → **API keys** → **Create API key** |
| `SENTRY_API_TOKEN` | Sentry → avatar → **User settings** → **Personal Tokens** → new token with only **Project: Read** and **Issue & Event: Read** |

**Variables tab → New repository variable.** These aren't secret.

| Name | Value |
|---|---|
| `APP_HEALTH_URL` | `https://place-and-plate.onrender.com/api/health` |
| `POLL_TIMEZONE` | `Asia/Kolkata` |
| `POLL_ACTIVE_HOURS` | `07-23` |
| `RENDER_SERVICE_ID` | open your app in Render; the page address contains `srv-…`. Copy that part. |
| `RENDER_OWNER_ID` | Render → **Workspace settings** → the ID starting `tea-…` |
| `SENTRY_API_URL` | `https://de.sentry.io` |
| `SENTRY_ORG` | `rles` |
| `SENTRY_PROJECT` | `place-and-plate` |
| `WORKER_ENABLED` | `true`. Add this **last**, after everything above. The worker stays off until it's set; change it to `false` any time to pause the worker. |

**Why the Render key is a secret only here:** Render keys can do everything in your account. Watchtower's code only ever *reads* with it (logs and deploys). It's only available to the scheduled worker, never to pull requests, and it's never logged or stored.

**Test it:** repo → **Actions** → **worker** → **Run workflow**. It should go green within about 2 minutes. If it fails, open the run, check the red step, and tell Claude what it says, leaving out any secrets.

**Load the test incidents (optional):** **Actions** → **seed** → **Run workflow**. It adds 9 fake incidents, labelled "seed data" on the dashboard. Run it again to reset them.

## 3. Render: the dashboard website

1. First, create your dashboard password hash on your laptop. In PowerShell:
   ```
   cd C:\dev\watchtower
   npm run hash-password
   ```
   Type a password of 12+ characters (nothing shows while you type) and press Enter. Copy the line starting `ADMIN_PASSWORD_HASH=`; you need the part after the `=`.
2. Make a session secret, also in PowerShell:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
3. In Render: **New → Web Service** → pick **RiazShaik79/watchtower** → fill in:
   - **Branch:** `main`
   - **Build command:** `npm ci && npm run build`
   - **Start command:** `npm start`
   - **Instance type:** **Free**
   - **Health check path** (under Advanced): `/login`
   - **Environment variables:**

     | Name | Value |
     |---|---|
     | `WT_DATABASE_URL` | same as the GitHub secret |
     | `WT_DATABASE_CA_CERT` | same as the GitHub secret |
     | `ADMIN_USER` | a username you choose |
     | `ADMIN_PASSWORD_HASH` | from step 3.1 |
     | `SESSION_SECRET` | from step 3.2 |
     | `POLL_TIMEZONE` | `Asia/Kolkata` |
4. Click **Create Web Service** and wait for **Live**. Open the address Render gives you (`https://watchtower-….onrender.com`) and sign in.

The dashboard sleeps when nobody's looking, so the first visit takes about a minute. It only uses free hours while you have it open.

**Don't add** `RENDER_API_KEY`, `SENTRY_API_TOKEN` or any Anthropic key to this Render service. The dashboard never needs them (architecture §2).
