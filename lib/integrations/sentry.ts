// Sentry API, read-only (verified to work on the Developer plan, 2026-10-29). The only place
// SENTRY_API_TOKEN is read. Optional: when unset, the worker skips Sentry.
import type { SentryIssue } from "../parse";

const TIMEOUT_MS = 30_000;

function config() {
  const token = process.env.SENTRY_API_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!token || !org || !project) return null;
  return { token, org, project, base: (process.env.SENTRY_API_URL || "https://sentry.io").replace(/\/+$/, "") };
}

export function sentryConfigured(): boolean {
  return config() !== null;
}

export class SentryApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Sentry API answered HTTP ${status}`);
    this.name = "SentryApiError";
    this.status = status;
  }
}

/** Unresolved issues seen in the last 24 h (first page, newest activity first). */
export async function fetchRecentIssues(): Promise<SentryIssue[]> {
  const cfg = config();
  if (!cfg) return [];
  const url = new URL(`${cfg.base}/api/0/projects/${encodeURIComponent(cfg.org)}/${encodeURIComponent(cfg.project)}/issues/`);
  url.searchParams.set("statsPeriod", "24h");
  url.searchParams.set("query", "is:unresolved");
  url.searchParams.set("sort", "date");
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new SentryApiError(res.status);
  return (await res.json()) as SentryIssue[];
}
