"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { getIncident, pendingDiagnosisRequest, requestDiagnosis } from "@/lib/db";
import { scrubText } from "@/lib/scrub";
import { TERMINAL_STATUSES } from "@/lib/types";

/**
 * Queue a (deep) re-diagnose. The dashboard never calls Claude: it writes an audited request that
 * the next worker run picks up (architecture §2). One pending request per incident.
 */
export async function requestRediagnose(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = Number(formData.get("incidentId"));
  if (!Number.isInteger(id) || id <= 0) return;
  const incident = await getIncident(id);
  if (!incident || TERMINAL_STATUSES.includes(incident.status)) return;
  if (await pendingDiagnosisRequest(id)) return;
  const notes = scrubText(String(formData.get("notes") ?? "").trim(), 1000) || null;
  await requestDiagnosis(id, { deep: formData.get("deep") === "1", notes });
  revalidatePath(`/incidents/${id}`);
}
