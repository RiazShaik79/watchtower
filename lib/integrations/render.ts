// Render API, read-only (GET only). The only place RENDER_API_KEY is read. Used only by the worker
// (GitHub Actions, schedule/workflow_dispatch). Never log, store or send the key anywhere.
import type { RenderLogLine } from "../parse";
import type { DeployInfo } from "../pipeline";

const BASE = "https://api.render.com/v1";
const TIMEOUT_MS = 30_000;

function config() {
  const key = process.env.RENDER_API_KEY;
  const ownerId = process.env.RENDER_OWNER_ID;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!key || !ownerId || !serviceId) return null;
  return { key, ownerId, serviceId };
}

export function renderConfigured(): boolean {
  return config() !== null;
}

/** Thrown for any non-2xx answer; carries only the status, never the response body. */
export class RenderApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string) {
    super(`Render API ${path} answered HTTP ${status}`);
    this.name = "RenderApiError";
    this.status = status;
    this.path = path;
  }
}

async function get<T>(path: string, params: Record<string, string | string[]>): Promise<T> {
  const cfg = config();
  if (!cfg) throw new Error("Render API is not configured (RENDER_API_KEY, RENDER_OWNER_ID, RENDER_SERVICE_ID).");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, value);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new RenderApiError(res.status, path);
  return (await res.json()) as T;
}

interface LogsPage {
  hasMore: boolean;
  nextStartTime?: string;
  nextEndTime?: string;
  logs: RenderLogLine[];
}

/**
 * App logs between `start` and `end`, oldest first, following Render's paging. Stops after
 * `maxPages` (100 lines each) and reports `truncated` so the caller can resume from the last line.
 */
export async function fetchLogs(start: Date, end: Date, maxPages = 10): Promise<{ logs: RenderLogLine[]; truncated: boolean }> {
  const cfg = config();
  if (!cfg) throw new Error("Render API is not configured.");
  const logs: RenderLogLine[] = [];
  let startTime = start.toISOString();
  let endTime = end.toISOString();
  for (let page = 0; page < maxPages; page++) {
    const data = await get<LogsPage>("/logs", {
      ownerId: cfg.ownerId,
      resource: cfg.serviceId,
      type: "app",
      direction: "forward",
      startTime,
      endTime,
      limit: "100",
    });
    logs.push(...(data.logs ?? []));
    if (!data.hasMore || !data.nextStartTime || !data.nextEndTime) return { logs, truncated: false };
    startTime = data.nextStartTime;
    endTime = data.nextEndTime;
  }
  return { logs, truncated: true };
}

interface DeployItem {
  deploy: {
    id: string;
    status: string;
    commit?: { id?: string; message?: string };
    createdAt: string;
    finishedAt?: string | null;
  };
}

export async function fetchDeploys(limit = 10): Promise<DeployInfo[]> {
  const cfg = config();
  if (!cfg) throw new Error("Render API is not configured.");
  const items = await get<DeployItem[]>(`/services/${encodeURIComponent(cfg.serviceId)}/deploys`, { limit: String(limit) });
  return items.map(({ deploy: d }) => ({
    id: d.id,
    status: d.status,
    commitId: d.commit?.id ?? null,
    commitMessage: d.commit?.message ?? null,
    createdAt: new Date(d.createdAt),
    finishedAt: d.finishedAt ? new Date(d.finishedAt) : null,
  }));
}
