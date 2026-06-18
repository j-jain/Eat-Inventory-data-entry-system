"use client";

import { signOut } from "@/actions/auth";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut()}
      className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
    >
      Sign out
    </button>
  );
}
