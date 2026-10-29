"use server";

import { redirect } from "next/navigation";
import { logout } from "@/lib/auth";

export async function signOut(): Promise<void> {
  await logout();
  redirect("/login");
}
