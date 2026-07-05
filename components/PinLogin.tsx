"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/actions/auth";
import { cn } from "@/lib/utils";

type U = { id: number; fullName: string; role: string };

const ROLE_LABEL: Record<string, string> = {
  FLOOR: "Floor",
  SUPERVISOR: "Supervisor",
  MANAGER: "Manager",
  ADMIN: "Admin",
};

/** Tap your name, type your PIN — two taps to work. Stays signed in on this
 *  device for 30 days. */
export function PinLogin({ users }: { users: U[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState<number | null>(users.length === 1 ? users[0].id : null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const selected = users.find((u) => u.id === userId) ?? null;

  function press(d: string) {
    setError(null);
    if (d === "←") setPin((p) => p.slice(0, -1));
    else if (pin.length < 4) {
      const next = pin + d;
      setPin(next);
      if (next.length === 4) submitWith(next); // auto-submit on 4th digit
    }
  }

  function submitWith(p: string) {
    if (!userId) return setError("Tap your name first.");
    start(async () => {
      const res = await signIn(userId, p);
      if (res.ok) {
        router.replace("/dashboard");
        router.refresh();
      } else {
        setError(res.error);
        setPin("");
      }
    });
  }

  if (!selected) {
    return (
      <div className="space-y-3">
        <p className="text-center text-sm text-neutral-500">Who's working?</p>
        <div className="grid grid-cols-2 gap-2.5">
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => {
                setUserId(u.id);
                setPin("");
                setError(null);
              }}
              className="flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-colors hover:border-brand hover:bg-brand/5 active:bg-brand/10"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand/20 text-base font-semibold text-brand-800">
                {u.fullName.slice(0, 1).toUpperCase()}
              </span>
              <span className="max-w-full truncate text-sm font-medium text-neutral-800">
                {u.fullName}
              </span>
              <span className="text-[11px] text-neutral-400">{ROLE_LABEL[u.role] ?? u.role}</span>
            </button>
          ))}
        </div>
        {users.length === 0 && (
          <p className="text-center text-sm text-neutral-400">
            No active users — ask an admin to add you.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => {
          setUserId(null);
          setPin("");
          setError(null);
        }}
        className="mx-auto flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand/20 text-xs font-semibold text-brand-800">
          {selected.fullName.slice(0, 1).toUpperCase()}
        </span>
        {selected.fullName}
        <span className="text-neutral-400">· change</span>
      </button>

      <div className="flex justify-center gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full transition-colors",
              i < pin.length ? "bg-brand" : "bg-neutral-300",
            )}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "←", "0", "OK"].map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => (k === "OK" ? submitWith(pin) : press(k))}
            disabled={pending || (k === "OK" && pin.length < 4)}
            className={cn(
              "min-h-[52px] rounded-lg py-3 text-lg font-medium disabled:opacity-50",
              k === "OK"
                ? "bg-brand text-ink hover:bg-brand-600"
                : "bg-neutral-100 text-neutral-800 hover:bg-neutral-200 active:bg-neutral-300",
            )}
          >
            {pending && k === "OK" ? "…" : k}
          </button>
        ))}
      </div>

      {pending && <p className="text-center text-sm text-neutral-400">Signing in…</p>}
      {error && <p className="text-center text-sm text-red-600">{error}</p>}
      <p className="text-center text-[11px] text-neutral-400">
        Stays signed in on this device for 30 days.
      </p>
    </div>
  );
}
