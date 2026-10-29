// Guardrail 6: every detection, agent call, approval, dismissal and triggered action writes an
// audit row. Details are scrubbed here so no caller can store raw text by accident.
import { scrubDeep } from "./scrub";
import type { Store } from "./store";
import type { AuditEntry } from "./types";

export async function audit(store: Pick<Store, "audit">, entry: AuditEntry): Promise<void> {
  await store.audit({ ...entry, detail: entry.detail ? (scrubDeep(entry.detail) as Record<string, unknown>) : undefined });
}
