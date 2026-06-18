"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/actions/auth";
import { SearchSelect } from "@/components/SearchSelect";

type U = { id: number; fullName: string; role: string };

export function PinLogin({ users }: { users: U[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(
    users.length === 1 ? String(users[0].id) : null,
  );
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const opts = users.map((u) => ({ value: String(u.id), label: u.fullName, hint: u.role }));

  function press(d: string) {
    setError(null);
    if (d === "←") setPin((p) => p.slice(0, -1));
    else if (pin.length < 4) setPin((p) => p + d);
  }

  function submit() {
    if (!userId) return setError("Pick your name first.");
    if (pin.length < 4) return setError("Enter your 4-digit PIN.");
    start(async () => {
      const res = await signIn(Number(userId), pin);
      if (res.ok) {
        router.replace("/dashboard");
        router.refresh();
      } else {
        setError(res.error);
        setPin("");
      }
    });
  }

  return (
    <div className="space-y-4">
      <SearchSelect
        options={opts}
        value={userId}
        onChange={setUserId}
        placeholder="Select your name"
      />

      <div className="flex justify-center gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-3 w-3 rounded-full ${i < pin.length ? "bg-emerald-600" : "bg-neutral-300"}`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "←", "0", "OK"].map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => (k === "OK" ? submit() : press(k))}
            disabled={pending}
            className={`rounded-lg py-3 text-lg font-medium ${
              k === "OK"
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "bg-neutral-100 text-neutral-800 hover:bg-neutral-200"
            } disabled:opacity-50`}
          >
            {pending && k === "OK" ? "…" : k}
          </button>
        ))}
      </div>

      {error && <p className="text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
