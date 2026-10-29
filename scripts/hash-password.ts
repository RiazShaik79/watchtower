// `npm run hash-password`: type the admin password (not echoed); prints the scrypt hash to put in
// ADMIN_PASSWORD_HASH. The plain password is never stored or printed.
import { hashPassword } from "@/lib/password";

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped input: read the first line.
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0] ?? "";
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const password = await readHidden("Admin password (min 12 characters): ");
if (password.length < 12) {
  console.error("Too short: use at least 12 characters.");
  process.exit(1);
}
console.log(`\nADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
