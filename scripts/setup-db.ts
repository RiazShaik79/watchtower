// `npm run db:setup`: one-time creation of Watchtower's own database and a user limited to it
// (ADR 0003), using the Aiven admin Service URI. The URI is typed in hidden, kept in memory only
// and never written to disk or logs. Prints the new WT_DATABASE_URL once.
import fs from "node:fs";
import { setupWatchtowerDatabase, UserExistsError, type SetupResult } from "@/lib/db";
import { readHidden, readLine } from "./prompt";

console.log(`
Watchtower database setup
-------------------------
This creates a database "watchtower" and a user "watchtower" that can only use that database,
checks it can't see your app's data, and creates Watchtower's tables.

You need, from Aiven -> your MySQL service -> Overview:
  1. the Service URI (starts with mysql://avnadmin:...). It's used once and not saved.
  2. the CA certificate, downloaded as a file (ca.pem).
`);

const adminUrl = (await readHidden("Paste the Service URI (hidden) and press Enter: ")).trim();
if (!adminUrl.startsWith("mysql://")) {
  console.error("That doesn't look like a Service URI (it should start with mysql://).");
  process.exit(1);
}
const caPath = (await readLine("Path to ca.pem (you can drag the file into this window): ")).trim().replace(/^["']|["']$/g, "").replace(/^& '/, "").replace(/'$/, "");
let caCert: string | undefined;
if (caPath) {
  try {
    caCert = fs.readFileSync(caPath, "utf8");
  } catch {
    console.error(`Couldn't read ${caPath}.`);
    process.exit(1);
  }
  if (!caCert.includes("BEGIN CERTIFICATE")) {
    console.error("That file isn't a certificate (no BEGIN CERTIFICATE line).");
    process.exit(1);
  }
}

async function run(rotatePassword: boolean): Promise<SetupResult> {
  return setupWatchtowerDatabase({ adminUrl, caCert, rotatePassword });
}

let result: SetupResult;
try {
  console.log("\nWorking...");
  try {
    result = await run(false);
  } catch (err) {
    if (!(err instanceof UserExistsError)) throw err;
    const answer = (await readLine('\nThe user "watchtower" already exists. Give it a NEW password? Anything using the old one must be updated. (yes/no): ')).trim().toLowerCase();
    if (answer !== "yes" && answer !== "y") {
      console.log("Nothing changed.");
      process.exit(0);
    }
    result = await run(true);
  }
} catch (err) {
  const e = err as { code?: string; message?: string };
  console.error(`\nSetup failed: ${e.code ?? ""} ${e.message ?? String(err)}`.replace(/mysql:\/\/[^\s]+/g, "[URL hidden]"));
  if (e.code === "ER_SPECIFIC_ACCESS_DENIED_ERROR" || e.code === "ER_ACCESS_DENIED_ERROR" || e.code === "ER_DBACCESS_DENIED_ERROR") {
    console.error("The admin user isn't allowed to create databases or users here. Tell Claude this message (not the URI).");
  }
  process.exit(1);
}

console.log("\nChecks:");
for (const c of result.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);

if (!result.ok || !result.databaseUrl) {
  console.log(`
Something isn't isolated as it should be, so no connection details are shown.
Don't use this database yet. Tell Claude which check FAILED (copy the lines above; they contain no secrets).`);
  process.exit(1);
}

console.log(`  PASS  tables created (${result.migrationsApplied.length ? result.migrationsApplied.join(", ") : "already up to date"})

All done. Copy the line below into BOTH places, then close this window:
  - GitHub: Watchtower repo -> Settings -> Secrets and variables -> Actions -> secret WT_DATABASE_URL
  - Render: the Watchtower dashboard service -> Environment -> WT_DATABASE_URL
Keep it private: don't paste it into chats, issues or emails (including to Claude).

${result.databaseUrl}

For WT_DATABASE_CA_CERT (both places), use the whole text of ${caPath || "your ca.pem"}.
  Tip: in PowerShell, Get-Content "${caPath || "ca.pem"}" | Set-Clipboard copies it.
`);
