"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { login } from "@/lib/auth";

export async function signIn(formData: FormData): Promise<void> {
  const username = String(formData.get("username") ?? "").slice(0, 100);
  const password = String(formData.get("password") ?? "").slice(0, 200);
  // Render puts the client address first in X-Forwarded-For.
  const clientKey = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const result = await login(username, password, clientKey);
  if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error)}`);
  redirect("/");
}
