import { redirect } from "next/navigation";
import { isSignedIn } from "@/lib/auth";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

const KNOWN_ERRORS = new Set(["Wrong username or password.", "Too many attempts. Wait 15 minutes and try again."]);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isSignedIn()) redirect("/");
  const { error } = await searchParams;
  const message = error && KNOWN_ERRORS.has(error) ? error : error ? "Sign-in failed." : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold">Watchtower</h1>
      <p className="mt-1 text-sm text-muted">Incident monitor for Plate &amp; Pace</p>
      <form action={signIn} className="mt-8 space-y-4 rounded-xl border border-line bg-surface p-6">
        <label className="block">
          <span className="text-sm font-medium">Username</span>
          <input
            name="username"
            autoComplete="username"
            required
            className="mt-1 w-full rounded-full border border-line bg-paper px-4 py-2 outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-full border border-line bg-paper px-4 py-2 outline-none focus:border-accent"
          />
        </label>
        {message ? (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        ) : null}
        <button type="submit" className="w-full rounded-full bg-accent px-4 py-2 font-medium text-white hover:opacity-90">
          Sign in
        </button>
      </form>
    </main>
  );
}
