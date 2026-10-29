// Guardrail 5: KILL_SWITCH=true or the dashboard toggle (setting `kill_switch` = "on") disables all
// agent calls and workflow triggers. Call sites check this themselves, not only the UI.
// Phase 2 has no agent calls or triggers yet; the worker records the state on every tick.
import type { Store } from "./store";

export function killSwitchFromEnv(): boolean {
  return process.env.KILL_SWITCH?.trim().toLowerCase() === "true";
}

export async function isKillSwitchOn(store: Pick<Store, "getSetting">): Promise<boolean> {
  if (killSwitchFromEnv()) return true;
  return (await store.getSetting("kill_switch")) === "on";
}
