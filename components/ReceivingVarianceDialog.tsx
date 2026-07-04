"use client";

import { useState } from "react";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { WASTAGE_REASONS } from "@/lib/constants";
import { D } from "@/lib/money";

/** A receiving line whose accepted qty differs from its remaining PO qty. */
export type VarianceLine = {
  rowKey: string;
  skuCode: string;
  skuName: string;
  uom: string;
  remainingQty: string;
  acceptedQty: string;
};

/** The chosen scenario for one line — matches the server VarianceSchema. */
export type Variance =
  | { type: "S1_FREE_LEFTOVER"; freeQty: string }
  | { type: "S2_OVER_RECEIPT" }
  | { type: "S4_SHORT_BILLED_FULL"; wasteReason: string };

/** Which scenario a line is currently set to (PARTIAL = no variance). */
type Mode = "PARTIAL" | "S1_FREE_LEFTOVER" | "S2_OVER_RECEIPT" | "S4_SHORT_BILLED_FULL";

type LineState = { mode: Mode; freeQty: string; wasteReason: string };

const REASON_OPTS: Option[] = WASTAGE_REASONS.map((r) => ({
  value: r.code,
  label: r.label,
}));

function initialMode(over: boolean): Mode {
  // Over-receipt has no partial/S1/S4 — S2 is the only valid scenario.
  return over ? "S2_OVER_RECEIPT" : "PARTIAL";
}

export function ReceivingVarianceDialog({
  lines,
  onConfirm,
  onCancel,
}: {
  lines: VarianceLine[];
  onConfirm: (result: Record<string, Variance | undefined>) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<Record<string, LineState>>(() => {
    const s: Record<string, LineState> = {};
    for (const ln of lines) {
      const over = D(ln.acceptedQty).gt(D(ln.remainingQty));
      s[ln.rowKey] = { mode: initialMode(over), freeQty: "", wasteReason: "" };
    }
    return s;
  });
  const [error, setError] = useState<string | null>(null);

  function set(rowKey: string, patch: Partial<LineState>) {
    setState((s) => ({ ...s, [rowKey]: { ...s[rowKey], ...patch } }));
  }

  function confirm() {
    const result: Record<string, Variance | undefined> = {};
    for (const ln of lines) {
      const st = state[ln.rowKey];
      const gap = D(ln.remainingQty).minus(D(ln.acceptedQty)); // remaining − accepted
      switch (st.mode) {
        case "PARTIAL":
          result[ln.rowKey] = undefined;
          break;
        case "S1_FREE_LEFTOVER": {
          const free = st.freeQty.trim();
          if (!free || !(D(free).gt(0) && D(free).lte(gap))) {
            setError(
              `${ln.skuCode}: free qty must be greater than 0 and at most ${gap.toFixed(3)} (remaining − accepted).`,
            );
            return;
          }
          result[ln.rowKey] = { type: "S1_FREE_LEFTOVER", freeQty: free };
          break;
        }
        case "S2_OVER_RECEIPT":
          result[ln.rowKey] = { type: "S2_OVER_RECEIPT" };
          break;
        case "S4_SHORT_BILLED_FULL": {
          if (!st.wasteReason) {
            setError(`${ln.skuCode}: pick a wastage reason for the short-billed-full receipt.`);
            return;
          }
          result[ln.rowKey] = {
            type: "S4_SHORT_BILLED_FULL",
            wasteReason: st.wasteReason,
          };
          break;
        }
      }
    }
    setError(null);
    onConfirm(result);
  }

  return (
    <div className="fixed inset-0 z-[1100] flex items-stretch justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden bg-white shadow-xl sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-xl">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-base font-semibold text-neutral-900">
            Confirm delivery variances
          </h2>
          <p className="mt-0.5 text-sm text-neutral-500">
            These lines were received short of, or above, their remaining PO
            quantity. Tell us what happened on each so stock, wastage and billing
            stay correct.
          </p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {lines.map((ln) => {
            const st = state[ln.rowKey];
            const over = D(ln.acceptedQty).gt(D(ln.remainingQty));
            const gap = D(ln.remainingQty).minus(D(ln.acceptedQty));
            return (
              <div
                key={ln.rowKey}
                className="rounded-lg border border-neutral-200 p-3"
              >
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="text-sm font-medium text-neutral-800">
                    <span className="font-mono text-xs text-neutral-500">
                      {ln.skuCode}
                    </span>{" "}
                    {ln.skuName}
                  </div>
                  <div className="font-mono text-xs text-neutral-500">
                    accepted {ln.acceptedQty} · remaining {ln.remainingQty} {ln.uom}
                  </div>
                </div>

                <div className="space-y-1.5">
                  {over ? (
                    <RadioRow
                      name={ln.rowKey}
                      checked={st.mode === "S2_OVER_RECEIPT"}
                      onChange={() => set(ln.rowKey, { mode: "S2_OVER_RECEIPT" })}
                      label="S2: vendor supplied more — update PO & bill to actual"
                    />
                  ) : (
                    <>
                      <RadioRow
                        name={ln.rowKey}
                        checked={st.mode === "PARTIAL"}
                        onChange={() => set(ln.rowKey, { mode: "PARTIAL" })}
                        label="Partial delivery — more coming"
                      />
                      <RadioRow
                        name={ln.rowKey}
                        checked={st.mode === "S1_FREE_LEFTOVER"}
                        onChange={() =>
                          set(ln.rowKey, { mode: "S1_FREE_LEFTOVER" })
                        }
                        label="S1: vendor left the rest free (₹0)"
                      >
                        {st.mode === "S1_FREE_LEFTOVER" && (
                          <div className="mt-1.5 flex items-center gap-2 pl-6">
                            <input
                              type="number"
                              step="0.001"
                              inputMode="decimal"
                              value={st.freeQty}
                              onChange={(e) =>
                                set(ln.rowKey, { freeQty: e.target.value })
                              }
                              placeholder="Free qty"
                              className="w-28 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                            />
                            <span className="text-xs text-neutral-400">
                              max {gap.toFixed(3)} {ln.uom}
                            </span>
                          </div>
                        )}
                      </RadioRow>
                      <RadioRow
                        name={ln.rowKey}
                        checked={st.mode === "S4_SHORT_BILLED_FULL"}
                        onChange={() =>
                          set(ln.rowKey, { mode: "S4_SHORT_BILLED_FULL" })
                        }
                        label="S4: short but billed full — missing goes to wastage"
                      >
                        {st.mode === "S4_SHORT_BILLED_FULL" && (
                          <div className="mt-1.5 pl-6">
                            <SearchSelect
                              className="w-56"
                              options={REASON_OPTS}
                              value={st.wasteReason || null}
                              onChange={(v) =>
                                set(ln.rowKey, { wasteReason: v ?? "" })
                              }
                              placeholder="Wastage reason"
                            />
                          </div>
                        )}
                      </RadioRow>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-neutral-200 px-5 py-3">
          {error && (
            <span className="mr-auto text-sm font-medium text-red-600">{error}</span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-ink hover:bg-brand-600"
          >
            Confirm & save
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioRow({
  name,
  checked,
  onChange,
  label,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onChange}
          className="mt-0.5 accent-brand-700"
        />
        <span>{label}</span>
      </label>
      {children}
    </div>
  );
}
