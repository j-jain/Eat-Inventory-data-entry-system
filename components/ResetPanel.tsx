"use client";

import { useState, useTransition } from "react";
import { resetOperationalData } from "@/actions/admin";

/**
 * Testing-only danger zone: wipes all operational data AND the Zoho cache, then
 * re-pulls fresh from Zoho. The button only arms once the user types RESET.
 * Rendered only when ALLOW_RESET=true (checked server-side in the page), and the
 * action re-checks the flag + admin role.
 */
export function ResetPanel() {
  const [confirm, setConfirm] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const armed = confirm.trim().toUpperCase() === "RESET";

  function run() {
    setMsg(null);
    start(async () => {
      const res = await resetOperationalData("RESET");
      if (res.ok) {
        let text = `Cleared ${res.tables} tables.`;
        if (res.zoho === "done") text += ` Re-pulled ${res.pulled} rows from Zoho.`;
        else if (res.zoho === "partial")
          text += ` Re-pull partly failed: ${res.zohoError}`;
        else text += " Zoho not configured — skipped re-pull.";
        text += " Users & SKUs kept.";
        setMsg({ type: "ok", text });
        setConfirm("");
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5">
      <h2 className="text-sm font-semibold text-red-700">Danger zone — reset test data</h2>
      <p className="mt-1 max-w-2xl text-xs text-red-700/80">
        Deletes <b>all operational entries</b> (receiving, sorting, assembly, returns,
        wastage, adjustments) plus the ledger and stock balances, <b>clears the Zoho
        cache and re-pulls everything fresh from Zoho</b>. Keeps SKUs and users. This
        cannot be undone and may take a little while. Type <b>RESET</b> to enable the button.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type RESET"
          className="w-40 rounded border border-red-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
        />
        <button
          type="button"
          disabled={!armed || pending}
          onClick={run}
          className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
        >
          {pending ? "Resetting…" : "Reset operational data"}
        </button>
        {msg && (
          <span
            className={
              msg.type === "ok"
                ? "text-sm font-medium text-brand-800"
                : "text-sm font-medium text-red-600"
            }
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
