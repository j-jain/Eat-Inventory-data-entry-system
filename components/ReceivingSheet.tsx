"use client";

import { useRef, useState } from "react";
import { EntryForm, type SkuOpt } from "@/components/EntryForm";
import {
  ReceivingVarianceDialog,
  type Variance,
  type VarianceLine,
} from "@/components/ReceivingVarianceDialog";
import { submitReceivingBatch } from "@/actions/entries";
import { D } from "@/lib/money";

type Row = Record<string, string>;

/**
 * Receiving = EntryForm + the variance interceptor. When any PO line's
 * accepted qty differs from its remaining qty, the dialog walks the operator
 * through the real-world scenarios (partial delivery / S1 free leftover /
 * S2 over-receipt / S4 short-but-billed-full) before the save is submitted.
 */
export function ReceivingSheet({
  mothers,
  initialRows,
  canPushToZoho,
  pushLabel,
  allowAddRow,
}: {
  mothers: SkuOpt[];
  initialRows?: Row[];
  canPushToZoho: boolean;
  pushLabel: string;
  allowAddRow: boolean;
}) {
  const [dialog, setDialog] = useState<{ lines: VarianceLine[]; rows: Row[] } | null>(null);
  const resolver = useRef<((r: { proceed: boolean; patched?: unknown[] }) => void) | null>(null);

  function beforeSubmit(rowsIn: unknown[]): Promise<{ proceed: boolean; patched?: unknown[] }> {
    const rows = rowsIn as Row[];
    const varianceLines: VarianceLine[] = [];
    rows.forEach((r, i) => {
      if (!r.zohoPoId || !r.skuId || !r.acceptedQty || !r.expectedQty) return;
      if (D(r.acceptedQty).eq(D(r.expectedQty))) return;
      varianceLines.push({
        rowKey: String(i),
        skuCode: r.skuCode || "",
        skuName: r.itemName || "",
        uom: r.uom || "kg",
        remainingQty: r.expectedQty,
        acceptedQty: r.acceptedQty,
      });
    });
    if (varianceLines.length === 0) return Promise.resolve({ proceed: true });
    return new Promise((resolve) => {
      resolver.current = resolve;
      setDialog({ lines: varianceLines, rows });
    });
  }

  function onConfirm(result: Record<string, Variance | undefined>) {
    const rows = dialog?.rows ?? [];
    const patched = rows.map((r, i) => {
      const v = result[String(i)];
      if (!v) {
        // strip any stale scenario from a previous attempt
        if (r.__variance) {
          const { __variance: _drop, ...rest } = r;
          void _drop;
          return rest;
        }
        return r;
      }
      return { ...r, __variance: JSON.stringify(v) };
    });
    setDialog(null);
    resolver.current?.({ proceed: true, patched });
    resolver.current = null;
  }

  function onCancel() {
    setDialog(null);
    resolver.current?.({ proceed: false });
    resolver.current = null;
  }

  return (
    <>
      <EntryForm
        kind="receiving"
        action={submitReceivingBatch}
        motherSkus={mothers}
        initialRows={initialRows}
        canPushToZoho={canPushToZoho}
        pushLabel={pushLabel}
        allowAddRow={allowAddRow}
        beforeSubmit={beforeSubmit}
      />
      {dialog && (
        <ReceivingVarianceDialog
          lines={dialog.lines}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
