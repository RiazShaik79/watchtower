// Grouping key (architecture §5): sha256(kind | error type | location | normalised message).
// Location is the app route when known (the same error reported by the logs and by Sentry then
// groups together), else the top in-app stack frame, else a normalised SQL snippet.
import { createHash } from "node:crypto";
import type { Kind } from "./types";

/** Replace the variable parts of a message so repeats of one error hash the same. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\[(?:EMAIL|TOKEN|REDACTED|DB_URL|PEM|CARD|IP|CREDENTIALS)\]/g, "<redacted>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g, "<str>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** "/api/log/42" or "/api/log/[id]" → "/api/log/:id" (numbers and UUIDs become :id). */
export function normalizeRoute(route: string): string {
  return (
    route
      .split("?")[0]!
      .replace(/\[[^\]]+\]/g, ":id")
      .replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27})(?=\/|$)/gi, "/:id")
      .replace(/\/+$/, "") || "/"
  );
}

const NOT_IN_APP = /node_modules|node:internal|\(node:|next\/dist|webpack-internal|<anonymous>|\[native code\]/;

/**
 * The first in-app frame of a V8 stack as "file:function", with the deployment prefix,
 * build output folders, chunk hashes, extension and line numbers removed.
 */
export function topInAppFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ") || NOT_IN_APP.test(line)) continue;
    const m = /^at (?:async )?(?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?$/.exec(line);
    if (!m) continue;
    const fn = (m[1] ?? "").replace(/^Object\.|^Module\./, "") || "<anon>";
    const file = m[2]!
      .replace(/^file:\/\//, "")
      .replace(/\\/g, "/")
      .replace(/^.*?\/\.next\/(?:server\/)?/, "")
      .replace(/^.*?\/project\/src\//, "")
      .replace(/^chunks\/(?:ssr\/)?/, "")
      .replace(/[._-][0-9a-f]{6,}(?=\.)/gi, "")
      .replace(/\.[cm]?[jt]sx?$/, "");
    return `${file}:${fn}`;
  }
  return "";
}

/** Location used for grouping: route > top in-app frame > given fallback. */
export function groupingLocation(route?: string, stack?: string, fallback?: string): string {
  if (route) return normalizeRoute(route);
  return topInAppFrame(stack) || (fallback ? normalizeMessage(fallback).slice(0, 120) : "");
}

export function fingerprint(kind: Kind, errorType: string, location: string, message: string): string {
  return createHash("sha256")
    .update([kind, errorType, location, normalizeMessage(message)].join("|"))
    .digest("hex");
}

/** Fixed fingerprints: health-poll incidents, and "database unreachable" whatever the error code. */
export const HEALTH_APP_DOWN_FP = fingerprint("health", "app_down", "/api/health", "app unreachable");
export const HEALTH_DB_DOWN_FP = fingerprint("db", "health_db_down", "/api/health", "database down");
export const DB_CONNECTION_FP = fingerprint("db", "db_connection", "db", "database connection failed");
