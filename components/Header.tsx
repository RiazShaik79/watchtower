import Link from "next/link";
import { signOut } from "@/app/actions";

export function Header() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="font-semibold">
          Watchtower <span className="font-normal text-muted">for Plate &amp; Pace</span>
        </Link>
        <form action={signOut}>
          <button type="submit" className="rounded-full border border-line px-3 py-1 text-sm hover:bg-sunken">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
