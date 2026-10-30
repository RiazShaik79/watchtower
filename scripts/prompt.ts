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
    let done = false;
    const onData = (chunk: string) => {
      if (done) return; // swallow stray keys (e.g. the \n of a pasted \r\n) so the next prompt doesn't get them
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          if (value === "" && ch !== "\u0004") continue; // ignore an Enter before anything is typed
          done = true;
          process.stdout.write("\n");
          setTimeout(() => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            resolve(value);
          }, 200);
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
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt);
    return readPipedLine();
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    // readline must draw the prompt itself: it redraws the line and would erase text written before.
    return await rl.question(prompt);
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
