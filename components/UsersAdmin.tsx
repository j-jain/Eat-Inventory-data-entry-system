"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createUser,
  setUserActive,
  setUserPages,
  setUserPin,
  setUserRole,
  type UserAdminRow,
} from "@/actions/users";
import type { Role } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

const ROLES: Role[] = ["FLOOR", "SUPERVISOR", "MANAGER", "ADMIN"];

const ROLE_CHIP: Record<Role, string> = {
  FLOOR: "bg-neutral-100 text-neutral-600",
  SUPERVISOR: "bg-sky-100 text-sky-700",
  MANAGER: "bg-amber-100 text-amber-700",
  ADMIN: "bg-brand/25 text-brand-800",
};

export function UsersAdmin({
  rows,
  pageDefs,
  currentUserId,
}: {
  rows: UserAdminRow[];
  pageDefs: { href: string; label: string; group: string }[];
  currentUserId: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setFlash(null);
    start(async () => {
      const res = await fn();
      setFlash(res.ok ? { type: "ok", text: okMsg } : { type: "err", text: res.error ?? "Failed." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <CreateUserCard run={run} pending={pending} />
      {flash && (
        <p
          className={cn(
            "rounded-md px-3 py-2 text-sm",
            flash.type === "ok" ? "bg-brand/15 text-brand-800" : "bg-red-50 text-red-700",
          )}
        >
          {flash.text}
        </p>
      )}
      <div className="space-y-3">
        {rows.map((u) => (
          <UserCard
            key={u.id}
            u={u}
            pageDefs={pageDefs}
            self={u.id === currentUserId}
            pending={pending}
            run={run}
          />
        ))}
      </div>
    </div>
  );
}

type RunFn = (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => void;

function CreateUserCard({ run, pending }: { run: RunFn; pending: boolean }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("FLOOR");
  const [pin, setPin] = useState("");
  const valid = name.trim().length >= 2 && /^\d{4}$/.test(pin);

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-neutral-700">Add a user</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Full name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Suresh (Floor)"
            className="w-56 rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-800 focus:outline-none focus:ring-2 focus:ring-brand-600 md:text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-800 focus:outline-none focus:ring-2 focus:ring-brand-600 md:text-sm"
          >
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          4-digit PIN
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="1234"
            className="w-24 rounded-md border border-neutral-300 px-3 py-2 text-center font-mono text-base tracking-widest focus:outline-none focus:ring-2 focus:ring-brand-600 md:text-sm"
          />
        </label>
        <button
          type="button"
          disabled={pending || !valid}
          onClick={() => {
            run(() => createUser({ fullName: name.trim(), role, pin }), `User "${name.trim()}" created.`);
            setName("");
            setPin("");
            setRole("FLOOR");
          }}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
        >
          Create
        </button>
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        New users start with their role's default pages — customise below after creating.
      </p>
    </div>
  );
}

function UserCard({
  u,
  pageDefs,
  self,
  pending,
  run,
}: {
  u: UserAdminRow;
  pageDefs: { href: string; label: string; group: string }[];
  self: boolean;
  pending: boolean;
  run: RunFn;
}) {
  const [showPin, setShowPin] = useState(false);
  const [editPin, setEditPin] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [pagesOpen, setPagesOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(u.pages));

  const groups = [...new Set(pageDefs.map((p) => p.group))];

  return (
    <div
      className={cn(
        "rounded-xl border bg-white p-4 shadow-sm",
        u.isActive ? "border-neutral-200" : "border-red-200 bg-red-50/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/20 font-semibold text-brand-800">
          {u.fullName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-neutral-800">{u.fullName}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_CHIP[u.role]}`}>
              {u.role}
            </span>
            {!u.isActive && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                BLOCKED
              </span>
            )}
            {self && <span className="text-[11px] text-neutral-400">(you)</span>}
          </div>
          <div className="mt-0.5 text-xs text-neutral-400">
            Last login:{" "}
            {u.lastLoginAt
              ? new Date(u.lastLoginAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
              : "never"}
          </div>
        </div>

        {/* PIN */}
        <div className="flex items-center gap-2">
          {editPin ? (
            <>
              <input
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                autoFocus
                placeholder="new PIN"
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-center font-mono text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
              <button
                type="button"
                disabled={pending || !/^\d{4}$/.test(newPin)}
                onClick={() => {
                  run(() => setUserPin(u.id, newPin), `PIN updated for ${u.fullName}.`);
                  setEditPin(false);
                  setNewPin("");
                }}
                className="rounded-md bg-brand px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditPin(false)}
                className="text-xs text-neutral-400 hover:text-neutral-600"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="font-mono text-sm tracking-widest text-neutral-700">
                {showPin ? (u.pin ?? "····") : "••••"}
              </span>
              <button
                type="button"
                onClick={() => setShowPin((v) => !v)}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
                title={
                  u.pin
                    ? showPin
                      ? "Hide PIN"
                      : "Show PIN"
                    : "PIN not viewable (set before v3) — set a new one to see it"
                }
              >
                {showPin ? "🙈" : "👁"}
              </button>
              <button
                type="button"
                onClick={() => setEditPin(true)}
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
              >
                Change
              </button>
            </>
          )}
        </div>

        {/* role + block */}
        <select
          value={u.role}
          disabled={pending || self}
          onChange={(e) =>
            run(() => setUserRole(u.id, e.target.value as Role), `Role updated for ${u.fullName}.`)
          }
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 disabled:opacity-50"
        >
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || self}
          onClick={() =>
            run(
              () => setUserActive(u.id, !u.isActive),
              u.isActive ? `${u.fullName} blocked.` : `${u.fullName} unblocked.`,
            )
          }
          className={cn(
            "rounded-md px-3 py-1.5 text-sm disabled:opacity-50",
            u.isActive
              ? "border border-red-200 text-red-600 hover:bg-red-50"
              : "border border-brand bg-brand/10 text-brand-800 hover:bg-brand/20",
          )}
        >
          {u.isActive ? "Block" : "Unblock"}
        </button>
      </div>

      {/* pages */}
      <div className="mt-3 border-t border-neutral-100 pt-2">
        <button
          type="button"
          onClick={() => {
            setPagesOpen((v) => !v);
            setDraft(new Set(u.pages));
          }}
          className="text-xs text-sky-600 hover:underline"
        >
          {pagesOpen ? "Hide pages" : `Pages: ${u.customPages ? `custom (${u.pages.length})` : "role default"} →`}
        </button>
        {pagesOpen && (
          <div className="mt-2 space-y-2">
            {groups.map((g) => (
              <div key={g}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {g}
                </p>
                <div className="flex flex-wrap gap-2">
                  {pageDefs
                    .filter((p) => p.group === g)
                    .map((p) => {
                      const on = draft.has(p.href);
                      return (
                        <button
                          key={p.href}
                          type="button"
                          onClick={() =>
                            setDraft((d) => {
                              const n = new Set(d);
                              if (n.has(p.href)) n.delete(p.href);
                              else n.add(p.href);
                              return n;
                            })
                          }
                          className={cn(
                            "rounded-full border px-3 py-1.5 text-xs",
                            on
                              ? "border-brand bg-brand/15 text-brand-800"
                              : "border-neutral-200 text-neutral-400 hover:border-neutral-300",
                          )}
                        >
                          {on ? "✓ " : ""}
                          {p.label}
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() => setUserPages(u.id, [...draft]), `Pages saved for ${u.fullName}.`)
                }
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
              >
                Save pages
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() => setUserPages(u.id, null), `Pages reset to ${u.role} default.`)
                }
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
              >
                Reset to role default
              </button>
              <span className="text-[11px] text-neutral-400">
                Applies on the user's next click — no re-login needed.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
