// When to poll the app's health (ADR 0002), and how many Render free hours those polls cost.
// The worker itself runs every 15 min; only the health poll wakes the app, so only it is rationed.

/** Hour of day (0–23) at `now` in an IANA timezone. */
export function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(hour) % 24;
}

/** "07-23" → start 7 inclusive, end 23 exclusive. Wrapping windows ("22-06") are allowed. */
export function parseActiveHours(spec: string | undefined): { start: number; end: number } {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec((spec ?? "").trim());
  const start = m ? Number(m[1]) : 7;
  const end = m ? Number(m[2]) : 23;
  if (start > 23 || end > 24) return { start: 7, end: 23 };
  return { start, end };
}

export function isActiveHour(hour: number, { start, end }: { start: number; end: number }): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Overnight, poll at most this often (a little under an hour, so a late cron run still counts). */
export const OVERNIGHT_MIN_GAP_MS = 55 * 60_000;

export function shouldPollHealth(now: Date, timeZone: string, activeHours: string | undefined, lastPollAt: Date | null): boolean {
  if (isActiveHour(localHour(now, timeZone), parseActiveHours(activeHours))) return true;
  return !lastPollAt || now.getTime() - lastPollAt.getTime() >= OVERNIGHT_MIN_GAP_MS;
}

// ---------------------------------------------------------------------------------------------
// Free-hours estimate
// ---------------------------------------------------------------------------------------------

export const IDLE_SPIN_DOWN_MS = 15 * 60_000; // Render Free sleeps after 15 min without traffic
export const SPIN_UP_MS = 60_000;

/**
 * A poll keeps the app awake until 15 min after it. Overlapping awake periods are only counted
 * once; waking a sleeping app also costs about a minute of spin-up. Returns the minutes added.
 */
export function accrueAwake(awakeUntil: Date | null, pollAt: Date): { addedMinutes: number; awakeUntil: Date } {
  const end = new Date(pollAt.getTime() + IDLE_SPIN_DOWN_MS);
  // A poll right at the 15-min mark (the worker's own cadence) still finds the app awake.
  if (awakeUntil && awakeUntil.getTime() >= pollAt.getTime()) {
    return { addedMinutes: Math.max(0, end.getTime() - awakeUntil.getTime()) / 60_000, awakeUntil: end };
  }
  return { addedMinutes: (IDLE_SPIN_DOWN_MS + SPIN_UP_MS) / 60_000, awakeUntil: end };
}

/** "2026-10" in UTC: Render's monthly allowance resets on the 1st. */
export function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** Straight-line projection of this month's usage to month end. */
export function projectMonth(usedHours: number, now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.max(now.getTime() - start, 60 * 60_000);
  return (usedHours * (end - start)) / elapsed;
}
