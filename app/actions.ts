"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logout, requireAdmin } from "@/lib/auth";
import { setKillSwitch } from "@/lib/db";

export async function signOut(): Promise<void> {
  await logout();
  redirect("/login");
}

/** The dashboard kill-switch toggle (guardrail 5); audited in setKillSwitch. */
export async function toggleKillSwitch(formData: FormData): Promise<void> {
  await requireAdmin();
  await setKillSwitch(formData.get("on") === "1");
  revalidatePath("/");
}
