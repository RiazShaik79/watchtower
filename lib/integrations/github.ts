// GitHub, read-only: the monitored app's source at the deployed commit, for diagnosis. The only
// place GITHUB_CONTENTS_TOKEN is read. In the worker that's the job's own `github.token` (the app
// repo is public, so it only raises the rate limit); nothing here can write.

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 200_000;

export interface CommitInfo {
  sha: string;
  date: string;
  message: string;
}

/** Where diagnosis reads code from. lib/diagnose.ts depends on this, tests use a fake. */
export interface CodeSource {
  /** Every file path in the repo at `ref`. */
  tree(ref: string): Promise<string[]>;
  /** One file's text at `ref`, or null if it's missing or too big. */
  file(path: string, ref: string): Promise<string | null>;
  /** The newest `limit` commits reachable from `ref`. */
  commits(ref: string, limit: number): Promise<CommitInfo[]>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, what: string) {
    super(`GitHub API answered HTTP ${status} for ${what}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export function appRepo(): string {
  const repo = (process.env.APP_REPO || "RiazShaik79/Place-and-Plate").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("APP_REPO must look like owner/name.");
  return repo;
}

function headers(accept: string): Record<string, string> {
  const token = process.env.GITHUB_CONTENTS_TOKEN?.trim();
  return {
    Accept: accept,
    "User-Agent": "watchtower-diagnosis/1",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function get(url: string, accept: string, what: string): Promise<Response | null> {
  const res = await fetch(url, { method: "GET", headers: headers(accept), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubApiError(res.status, what);
  return res;
}

export function githubSource(repo: string = appRepo()): CodeSource {
  return {
    async tree(ref) {
      const res = await get(`${API}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, "application/vnd.github+json", "the file tree");
      if (!res) return [];
      const body = (await res.json()) as { tree?: { path: string; type: string }[] };
      return (body.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path);
    },
    async file(path, ref) {
      const res = await get(`${API}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw+json", "a file");
      if (!res) return null;
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_FILE_BYTES) return null;
      const text = await res.text();
      return text.length > MAX_FILE_BYTES ? null : text;
    },
    async commits(ref, limit) {
      const res = await get(`${API}/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${limit}`, "application/vnd.github+json", "the commit list");
      if (!res) return [];
      const body = (await res.json()) as { sha: string; commit?: { message?: string; author?: { date?: string } } }[];
      return body.slice(0, limit).map((c) => ({ sha: c.sha, date: c.commit?.author?.date ?? "", message: (c.commit?.message ?? "").split("\n")[0] ?? "" }));
    },
  };
}
