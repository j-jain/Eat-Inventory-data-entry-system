"use client";

import { useState, useTransition } from "react";
import { runZohoSync, type SyncEntity } from "@/actions/zoho";

const ENTITIES: { key: SyncEntity; label: string }[] = [
  { key: "items", label: "Items + stock (EAT SKUs)" },
  { key: "vendors", label: "Vendors" },
  { key: "customers", label: "Customers" },
  { key: "pos", label: "Open POs" },
  { key: "all", label: "Everything" },
];

export function SyncPanel({ enabled }: { enabled: boolean }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<SyncEntity | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  function run(entity: SyncEntity) {
    setMsg(null);
    setBusy(entity);
    start(async () => {
      const res = await runZohoSync(entity);
      setBusy(null);
      setMsg(
        res.ok
          ? { type: "ok", text: `Synced ${res.rows} rows.` }
          : { type: "err", text: res.error },
      );
    });
  }

  return (
    <div className="space-y-3">
      {!enabled && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Zoho is not configured yet. Reads are disabled until you set the{" "}
          <code>ZOHO_*</code> env vars. The app works fully without it — vendor /
          customer / invoice / PO dropdowns simply stay empty.
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {ENTITIES.map((e) => (
          <button
            key={e.key}
            type="button"
            disabled={pending || !enabled}
            onClick={() => run(e.key)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
          >
            {busy === e.key ? "Syncing…" : `Pull ${e.label}`}
          </button>
        ))}
      </div>
      {msg && (
        <p className={msg.type === "ok" ? "text-sm text-emerald-700" : "text-sm text-red-600"}>
          {msg.text}
        </p>
      )}
      <p className="text-xs text-neutral-400">
        Lean by design: only EAT SKUs are linked, only open POs are pulled, and
        invoices are fetched live per-customer during a return (no bulk invoice pull).
      </p>
    </div>
  );
}
