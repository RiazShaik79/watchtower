// Terminal prompts for the owner-run scripts (hash-password, db:setup).

/** Read a line without echoing it (passwords, admin URLs). Piped input reads the first line. */
export async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) return readPipedLine();
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Read a visible line. */
export async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) return readPipedLine();
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await rl.question("");
  } finally {
    rl.close();
  }
}

let piped: string[] | null = null;
async function readPipedLine(): Promise<string> {
  if (!piped) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    piped = data.split(/\r?\n/);
  }
  return piped.shift() ?? "";
}
