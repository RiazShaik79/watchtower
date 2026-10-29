// Structured logs: one JSON object per line (same shape as the app's lib/log.ts).
// Never pass secrets, tokens, raw payloads or unscrubbed log text in `fields`.
// LOG_FORMAT=pretty prints a short readable line instead (local dev).

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const MAX_STACK_FRAMES = 20;

/** An Error (or anything thrown) as plain JSON: name, message, code, a trimmed stack. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const code = (err as { code?: unknown }).code;
  const stack = err.stack?.split("\n").slice(0, MAX_STACK_FRAMES + 1).join("\n");
  return { name: err.name, message: err.message, ...(code !== undefined ? { code } : {}), ...(stack ? { stack } : {}) };
}

/** One log line as JSON. `err` fields are serialised; undefined values are left out. */
export function formatLog(level: LogLevel, msg: string, fields: LogFields = {}, now: Date = new Date()): string {
  const out: Record<string, unknown> = { ts: now.toISOString(), level, msg };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "ts" || key === "level" || key === "msg") continue;
    out[key] = value instanceof Error || key === "err" ? serializeError(value) : value;
  }
  return JSON.stringify(out);
}

function write(level: LogLevel, msg: string, fields?: LogFields) {
  const line =
    process.env.LOG_FORMAT === "pretty"
      ? `[${level}] ${msg}${fields && Object.keys(fields).length ? " " + JSON.stringify(fields, (_k, v) => (v instanceof Error ? serializeError(v) : v)) : ""}`
      : formatLog(level, msg, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
};
