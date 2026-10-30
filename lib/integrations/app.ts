// The monitored app's public health endpoint (APP_HEALTH_URL). No credentials involved.
// One poll = an attempt with a 120 s timeout (Render Free can take ~1 min to wake) plus 1 retry.
import type { HealthPoll } from "../severity";

const ATTEMPT_TIMEOUT_MS = 120_000;

async function attempt(url: string): Promise<{ httpStatus: number | null; db: "up" | "down" | null; chaos?: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "watchtower-health/1" },
      cache: "no-store",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    let db: "up" | "down" | null = null;
    let chaos: boolean | undefined;
    try {
      const body = (await res.json()) as { db?: unknown; chaos?: unknown };
      db = body.db === "up" || body.db === "down" ? body.db : null;
      chaos = body.chaos === true;
    } catch {
      db = null;
    }
    return { httpStatus: res.status, db, chaos, error: res.ok ? undefined : `http_${res.status}` };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { httpStatus: null, db: null, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

export async function pollHealth(now: () => Date = () => new Date()): Promise<HealthPoll> {
  const url = process.env.APP_HEALTH_URL;
  if (!url) throw new Error("APP_HEALTH_URL is not set.");
  const at = now();
  const started = performance.now();
  let result = await attempt(url);
  if (result.httpStatus !== 200 && result.db !== "down") result = await attempt(url); // 1 retry
  return { at, ms: Math.round(performance.now() - started), ...result };
}
