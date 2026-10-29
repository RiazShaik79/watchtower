// `npm run db:setup`: one-time creation of Watchtower's own database and a user limited to it
// (ADR 0003), using the Aiven admin Service URI. The URI is typed in hidden, kept in memory only
// and never written to disk or logs. Prints the new WT_DATABASE_URL once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupWatchtowerDatabase, UserExistsError, type SetupResult } from "@/lib/db";
import { readHidden, readLine } from "./prompt";

console.log(`
Watchtower database setup
-------------------------
This creates a database "watchtower" and a user "watchtower" that can only use that database,
checks it can't see your app's data, and creates Watchtower's tables.

You need, from Aiven -> your MySQL service -> Overview:
  1. the CA certificate, downloaded as a file (ca.pem).
  2. the Service URI (starts with mysql://avnadmin:...). It's used once and not saved.
`);

// The certificate is asked first and is required (Aiven always uses TLS). Asked after the
// hidden paste, a stray Enter from the paste could answer it with an empty line.
const defaultCa = newestDownloadedCa();
let caPath = "";
let caCert = "";
for (let attempt = 1; !caCert; attempt++) {
  if (attempt > 3) {
    console.error("No CA certificate, so nothing was changed. Download ca.pem from Aiven and run this again.");
    process.exit(1);
  }
  const hint = defaultCa ? ` [Enter = ${defaultCa}]` : "";
  const typed = (await readLine(`Path to ca.pem (you can drag the file into this window)${hint}: `)).trim().replace(/^& /, "").replace(/^["']|["']$/g, "");
  if (looksLikeCertificateText(typed)) {
    // Stop rather than re-ask: the rest of the pasted lines would be read as more answers.
    console.error(`
  That's the certificate's text. Give its location instead: drag the ca.pem file itself into
  this window${defaultCa ? ", or just press Enter to use the one in Downloads" : ""}. Nothing was changed; run npm run db:setup again.`);
    process.exit(1);
  }
  caPath = typed || defaultCa;
  if (!caPath) {
    console.error("  The ca.pem path is needed. Try again.");
    continue;
  }
  try {
    const text = fs.readFileSync(caPath, "utf8");
    if (text.includes("BEGIN CERTIFICATE")) caCert = text;
    else console.error("  That file isn't a certificate (no BEGIN CERTIFICATE line). Try again.");
  } catch {
    console.error(`  Couldn't read ${caPath}. Try again.`);
  }
}
console.log(`  Using ${caPath}`);

const adminUrl = (await readHidden("Paste the Service URI (hidden) and press Enter: ")).trim();
if (!adminUrl.startsWith("mysql://")) {
  console.error("That doesn't look like a Service URI (it should start with mysql://).");
  process.exit(1);
}

/** The newest ca*.pem in Downloads (browsers name repeats "ca (1).pem"), or "" if none. */
function newestDownloadedCa(): string {
  const dir = path.join(os.homedir(), "Downloads");
  try {
    return (
      fs
        .readdirSync(dir)
        .filter((f) => /^ca\b.*\.pem$/i.test(f))
        .map((f) => ({ file: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)[0]?.file ?? ""
    );
  } catch {
    return "";
  }
}

/** A PEM header/footer, or a long base64 line with nothing path-like in it. */
function looksLikeCertificateText(answer: string): boolean {
  if (answer.startsWith("-----")) return true;
  return answer.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(answer) && !/\.pem$/i.test(answer);
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
    let answer = "";
    for (let attempt = 0; !answer && attempt < 3; attempt++) {
      answer = (await readLine('\nThe user "watchtower" already exists. Give it a NEW password? Anything using the old one must be updated. (yes/no): ')).trim().toLowerCase();
    }
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
