// The incident lifecycle (architecture §4): every status change goes through transition(), which
// allows only the moves in TRANSITIONS and audits each one. Pure table + a store call, unit-tested.
// Phase 3 uses the moves into `diagnosed`. `fix_approved` is reserved for phase 4's approveFix(),
// which must insert the approvals row in the same transaction (guardrail 8), so it's refused here.
import { audit } from "./audit";
import type { DiagnosisStore } from "./store";
import type { Actor, IncidentStatus } from "./types";

export const TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  new: ["diagnosed", "dismissed"],
  diagnosed: ["diagnosed", "fix_approved", "dismissed"],
  fix_approved: ["pr_open", "failed"],
  pr_open: ["ci_passed", "failed", "dismissed"],
  ci_passed: ["merged"],
  merged: ["deployed"],
  deployed: ["verified", "regression"],
  regression: ["rolled_back", "diagnosed"],
  failed: ["diagnosed"],
  verified: [],
  dismissed: [],
  rolled_back: [],
};

/** Statuses only a dedicated, approval-checking function may move into. */
const GUARDED: readonly IncidentStatus[] = ["fix_approved"];

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: IncidentStatus, to: IncidentStatus, why: string) {
    super(`Incident can't go from ${from} to ${to}: ${why}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Move an incident from its current status to `to`. Throws (and audits) on a move the table doesn't
 * allow. Returns false, without changing anything, if the status changed underneath us.
 */
export async function transition(
  store: Pick<DiagnosisStore, "setIncidentStatus" | "audit">,
  incident: { id: number; status: IncidentStatus },
  to: IncidentStatus,
  actor: Actor,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const from = incident.status;
  const why = GUARDED.includes(to) ? "this status needs an approval and its own code path" : !canTransition(from, to) ? "not an allowed move" : null;
  if (why) {
    await audit(store, { actor, action: "invalid_transition", incidentId: incident.id, outcome: "denied", detail: { from, to, ...detail } });
    throw new InvalidTransitionError(from, to, why);
  }
  const changed = await store.setIncidentStatus(incident.id, from, to);
  await audit(store, {
    actor,
    action: "status_changed",
    incidentId: incident.id,
    outcome: changed ? "ok" : "skipped",
    detail: { from, to, ...detail, ...(changed ? {} : { reason: "status changed meanwhile" }) },
  });
  return changed;
}
