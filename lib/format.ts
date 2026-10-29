// Display helpers for the dashboard. Times are shown in POLL_TIMEZONE (default Asia/Kolkata).

export function displayTimeZone(): string {
  return process.env.POLL_TIMEZONE || "Asia/Kolkata";
}

export function formatDateTime(at: Date, timeZone: string = displayTimeZone()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function formatAgo(at: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const STALE_AFTER_MS = 45 * 60_000;

export function isStale(lastTickAt: Date | null, now: Date = new Date()): boolean {
  return !lastTickAt || now.getTime() - lastTickAt.getTime() > STALE_AFTER_MS;
}

export const KIND_LABELS = { error: "Error", health: "Health", db: "Database", slow_query: "Slow query" } as const;

export function statusLabel(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
