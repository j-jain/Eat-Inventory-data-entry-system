"use client";

import { useMemo, useState, useTransition } from "react";
import { pushToZoho } from "@/actions/zoho-drafts";
import type { ReviewRow, ReviewStatus } from "@/lib/zoho/review";
import type { CombinedStockRow } from "@/lib/ledger/balance";
import { D } from "@/lib/money";

type RowState = {
  row: ReviewRow;
  status: ReviewStatus;
  error: string | null;
  progress?: { pushed: number; total: number };
  busy: boolean;
};

const CHIP: Record<ReviewStatus, string> = {
  PENDING: "bg-neutral-100 text-neutral-600",
  PUSHED: "bg-brand/25 text-brand-800",
  PARTIAL: "bg-amber-100 text-amber-700",
  FAILED: "bg-red-100 text-red-700",
};

export function ReviewClient({
  rows,
  stock,
}: {
  rows: ReviewRow[];
  stock: CombinedStockRow[];
}) {
  const [pending, start] = useTransition();
  const [states, setStates] = useState<RowState[]>(() =>
    rows.map((row) => ({
      row,
      status: row.status,
      error: row.error,
      progress: row.progress,
      busy: false,
    })),
  );

  const counts = useMemo(() => {
    const c = { PENDING: 0, PUSHED: 0, PARTIAL: 0, FAILED: 0 } as Record<ReviewStatus, number>;
    for (const s of states) c[s.status] += 1;
    return c;
  }, [states]);

  function patch(idx: number, next: Partial<RowState>) {
    setStates((ss) => ss.map((s, i) => (i === idx ? { ...s, ...next } : s)));
  }

  // Push a single row by index; returns the resolved status.
  async function pushOne(idx: number): Promise<void> {
    const s = states[idx];
    if (!s) return;
    patch(idx, { busy: true });
    const res = await pushToZoho(s.row.kind, s.row.docId);
    if (!res.ok) {
      patch(idx, { busy: false, status: "FAILED", error: res.error });
      return;
    }
    const total = res.results.length;
    const pushed = res.results.filter((r) => r.ok).length;
    const firstErr = res.results.find((r) => !r.ok)?.error ?? null;
    const status: ReviewStatus =
      pushed >= total ? "PUSHED" : pushed > 0 ? "PARTIAL" : "FAILED";
    patch(idx, {
      busy: false,
      status,
      error: status === "PUSHED" ? null : firstErr,
      progress: total > 1 ? { pushed, total } : undefined,
    });
  }

  function pushRow(idx: number) {
    start(async () => {
      await pushOne(idx);
    });
  }

  function pushAll() {
    start(async () => {
      // sequential, in row order, continue on failure
      for (let i = 0; i < states.length; i++) {
        const st = states[i];
        if (st.status === "PENDING" || st.status === "FAILED" || st.status === "PARTIAL") {
          // read latest status defensively
          await pushOne(i);
        }
      }
    });
  }

  const hasPending = states.some(
    (s) => s.status === "PENDING" || s.status === "FAILED" || s.status === "PARTIAL",
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Chip status="PENDING" n={counts.PENDING} />
        <Chip status="FAILED" n={counts.FAILED} />
        <Chip status="PUSHED" n={counts.PUSHED} />
        {counts.PARTIAL > 0 && <Chip status="PARTIAL" n={counts.PARTIAL} />}
        <button
          type="button"
          onClick={pushAll}
          disabled={pending || !hasPending}
          className="ml-auto rounded-md bg-brand px-4 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
        >
          {pending ? "Pushing…" : "Push all pending"}
        </button>
      </div>

      <div className="space-y-2">
        {states.length === 0 && (
          <p className="text-sm text-neutral-400">Nothing to push in the last 30 days.</p>
        )}
        {states.map((s, i) => (
          <ReviewRowCard key={`${s.row.kind}-${s.row.docId}`} s={s} onPush={() => pushRow(i)} busy={pending} />
        ))}
      </div>

      <CombinedStock stock={stock} />
    </div>
  );
}

function Chip({ status, n }: { status: ReviewStatus; n: number }) {
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${CHIP[status]}`}>
      {n} {status.toLowerCase()}
    </span>
  );
}

function ReviewRowCard({
  s,
  onPush,
  busy,
}: {
  s: RowState;
  onPush: () => void;
  busy: boolean;
}) {
  const [showErr, setShowErr] = useState(false);
  const isPushed = s.status === "PUSHED";
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[s.status]}`}
        >
          {s.status === "PUSHED"
            ? "PUSHED ✓"
            : s.status === "PARTIAL" && s.progress
              ? `PARTIAL ${s.progress.pushed}/${s.progress.total}`
              : s.status}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-neutral-800">{s.row.summary}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-400">{s.row.businessDate}</span>
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
              {s.row.landsIn}
            </span>
          </div>
        </div>
        {!isPushed && (
          <button
            type="button"
            onClick={onPush}
            disabled={busy || s.busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {s.busy ? "Pushing…" : s.status === "PENDING" ? "Push" : "Retry"}
          </button>
        )}
      </div>
      {s.error && s.status !== "PUSHED" && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowErr((v) => !v)}
            className="text-xs text-red-600 hover:underline"
          >
            {showErr ? "Hide error" : "Show error"}
          </button>
          {showErr && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
              {s.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function CombinedStock({ stock }: { stock: CombinedStockRow[] }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const filtered = term
    ? stock.filter(
        (r) => r.code.toLowerCase().includes(term) || r.name.toLowerCase().includes(term),
      )
    : stock;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-neutral-700">
          Combined stock — Zoho + not yet pushed
        </h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by code or name…"
          className="w-64 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">SKU</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 text-right font-medium">Zoho qty</th>
              <th className="px-4 py-2 text-right font-medium">Local Δ</th>
              <th className="px-4 py-2 text-right font-medium">Combined</th>
              <th className="px-4 py-2 font-medium">UOM</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-neutral-400">
                  No stock
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const delta = D(r.unpushedDelta);
              const nonZero = !delta.isZero();
              const signed = delta.gt(0) ? `+${r.unpushedDelta}` : r.unpushedDelta;
              return (
                <tr key={r.skuId} className="border-t border-neutral-50">
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-600">{r.code}</td>
                  <td className="px-4 py-1.5 text-neutral-700">{r.name}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-neutral-600">{r.zohoQty}</td>
                  <td
                    className={`px-4 py-1.5 text-right font-mono ${nonZero ? "text-amber-600" : "text-neutral-400"}`}
                  >
                    {nonZero ? signed : "—"}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono font-semibold text-neutral-800">
                    {r.combinedQty}
                  </td>
                  <td className="px-4 py-1.5 text-neutral-500">{r.uom}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-xs text-neutral-400">Zoho figure as of last Items sync.</p>
    </div>
  );
}
