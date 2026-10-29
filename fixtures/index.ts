// Seed fixtures (`npm run seed`, tests): real-shaped Render log lines, Sentry issues, health
// series and deploys, with times relative to `now`. EXPECTED is what the pipeline must produce.
import fs from "node:fs";
import { parseRenderLog, parseSentryIssue, type RenderLogLine, type SentryIssue } from "@/lib/parse";
import { ingestSignals, recordDeploys, recordHealth, type DeployInfo } from "@/lib/pipeline";
import type { HealthPoll } from "@/lib/severity";
import type { Store } from "@/lib/store";
import type { Kind, Severity, Signal } from "@/lib/types";

const read = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

interface LogFixture {
  id: string;
  minutesAgo: number;
  message: unknown;
}
interface SentryFixture extends Omit<SentryIssue, "firstSeen" | "lastSeen"> {
  minutesAgoFirstSeen: number;
  minutesAgoLastSeen: number;
}
interface PollFixture {
  minutesAgo: number;
  httpStatus: number | null;
  ms: number;
  db: "up" | "down" | null;
  error?: string;
}
interface HealthFixtures {
  coldStart: { polls: PollFixture[] };
  outage: { polls: PollFixture[] };
  deploys: { id: string; status: string; commitId: string; commitMessage: string; minutesAgo: number }[];
}

export function seedLogLines(now: Date): RenderLogLine[] {
  return read<LogFixture[]>("render-logs.json").map((f) => ({
    id: f.id,
    timestamp: ago(now, f.minutesAgo).toISOString(),
    message: typeof f.message === "string" ? f.message : JSON.stringify(f.message),
  }));
}

export function seedSentryIssues(now: Date): SentryIssue[] {
  return read<SentryFixture[]>("sentry-issues.json").map(({ minutesAgoFirstSeen, minutesAgoLastSeen, ...issue }) => ({
    ...issue,
    firstSeen: ago(now, minutesAgoFirstSeen).toISOString(),
    lastSeen: ago(now, minutesAgoLastSeen).toISOString(),
  }));
}

export function seedHealthPolls(now: Date): HealthPoll[] {
  const h = read<HealthFixtures>("health-series.json");
  return [...h.coldStart.polls, ...h.outage.polls]
    .sort((a, b) => b.minutesAgo - a.minutesAgo)
    .map((p) => ({ at: ago(now, p.minutesAgo), httpStatus: p.httpStatus, ms: p.ms, db: p.db, error: p.error }));
}

export function seedDeploys(now: Date): DeployInfo[] {
  return read<HealthFixtures>("health-series.json").deploys.map((d) => ({
    id: d.id,
    status: d.status,
    commitId: d.commitId,
    commitMessage: d.commitMessage,
    createdAt: ago(now, d.minutesAgo + 4),
    finishedAt: ago(now, d.minutesAgo),
  }));
}

/** Replay every fixture through the real pipeline, in the order the worker would see them. */
export async function seedInto(store: Store, now: Date = new Date()): Promise<{ stored: number; duplicates: number; incidents: number }> {
  await recordDeploys(store, seedDeploys(now));
  for (const poll of seedHealthPolls(now)) await recordHealth(store, poll);
  const signals = [
    ...seedLogLines(now).map(parseRenderLog),
    ...seedSentryIssues(now).map((issue) => parseSentryIssue(issue, 0)),
  ].filter((s): s is Signal => s !== null);
  const result = await ingestSignals(store, signals);
  return { stored: result.stored, duplicates: result.duplicates, incidents: result.detected.length };
}

/** The incidents the fixtures must produce: grouped and with the right severity. */
export const EXPECTED: { titleIncludes: string; kind: Kind; severity: Severity; events: number }[] = [
  { titleIncludes: "TypeError: Cannot read properties of undefined", kind: "error", severity: "high", events: 6 }, // 4 log lines + 2 from Sentry
  { titleIncludes: "Database connection failed", kind: "db", severity: "medium", events: 3 },
  { titleIncludes: "Slow query", kind: "slow_query", severity: "medium", events: 6 },
  { titleIncludes: "places_lookup_failed", kind: "error", severity: "low", events: 1 },
  { titleIncludes: "connect failed for [DB_URL]", kind: "error", severity: "high", events: 1 },
  { titleIncludes: "IGNORE ALL PREVIOUS INSTRUCTIONS", kind: "error", severity: "high", events: 1 },
  { titleIncludes: "RangeError: Invalid time value", kind: "error", severity: "high", events: 1 },
  { titleIncludes: "App health check failing", kind: "health", severity: "critical", events: 3 },
  { titleIncludes: "Database down (reported by /api/health)", kind: "db", severity: "critical", events: 2 },
];

/** Text that must never be stored anywhere (all fake values planted in the fixtures). */
export const MUST_NOT_APPEAR = ["hunter2", "jane.doe@example.com", "bob@example.com", "fake-reset-token-for-tests", "abcdefghijklmnop1234", "10.0.4.17", "avnadmin"]; // gitleaks:allow
