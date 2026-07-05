"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

type Budget = { day: string; calls: number; writes: number; limit: number };
type SyncRow = {
  id: number;
  entity: string;
  status: string;
  rowsPulled: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};
type PushCount = { status: string; n: number };
type ProblemPush = {
  id: number;
  kind: string;
  docType: string;
  docId: number;
  subKey: string;
  status: string;
  error: string | null;
  idemRef: string | null;
  attempts: number;
  updatedAt: string;
};
type LogRow = {
  id: number;
  level: string;
  source: string;
  message: string;
  ctx: unknown;
  userId: number | null;
  createdAt: string;
};

const LEVEL_CHIP: Record<string, string> = {
  ERROR: "bg-red-100 text-red-700",
  WARN: "bg-amber-100 text-amber-700",
  INFO: "bg-neutral-100 text-neutral-600",
};

const ist = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";

export function DevDashboard({
  budget,
  syncs,
  pushCounts,
  problemPushes,
  logs,
}: {
  budget: Budget;
  syncs: SyncRow[];
  pushCounts: PushCount[];
  problemPushes: ProblemPush[];
  logs: LogRow[];
}) {
  const [level, setLevel] = useState<"ALL" | "ERROR" | "WARN">("ALL");
  const [copied, setCopied] = useState<number | null>(null);

  const filteredLogs = useMemo(
    () =>
      level === "ALL"
        ? logs
        : logs.filter((l) => (level === "ERROR" ? l.level === "ERROR" : l.level !== "INFO")),
    [logs, level],
  );

  const pct = Math.min(100, Math.round((budget.calls / budget.limit) * 100));
  const countOf = (s: string) => pushCounts.find((p) => p.status === s)?.n ?? 0;
  const lastSyncByEntity = new Map<string, SyncRow>();
  for (const s of syncs) if (!lastSyncByEntity.has(s.entity)) lastSyncByEntity.set(s.entity, s);

  async function copyBundle(l: LogRow) {
    const bundle = [
      `EAT Inventory error bundle — paste this to Claude`,
      `time (IST): ${ist(l.createdAt)}`,
      `level: ${l.level}`,
      `source: ${l.source}`,
      `message: ${l.message}`,
      `user id: ${l.userId ?? "—"}`,
      `context: ${JSON.stringify(l.ctx, null, 2)}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(bundle);
      setCopied(l.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="space-y-5">
      {/* health strip */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Zoho API budget · {budget.day}
          </p>
          <p className="mt-1 font-mono text-xl font-semibold text-ink">
            {budget.calls.toLocaleString("en-IN")}
            <span className="text-sm font-normal text-neutral-400"> / {budget.limit.toLocaleString("en-IN")} calls</span>
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
            <div
              className={cn(
                "h-2 rounded-full",
                pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-400" : "bg-brand",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            {budget.writes} of those were writes. Standard plan = 2,000/day, 100/min.
          </p>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Push health
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-brand/20 px-2.5 py-1 font-medium text-brand-800">
              {countOf("SUCCESS")} pushed
            </span>
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-600">
              {countOf("PENDING")} pending
            </span>
            {countOf("FAILED") > 0 && (
              <span className="rounded-full bg-red-100 px-2.5 py-1 font-medium text-red-700">
                {countOf("FAILED")} failed
              </span>
            )}
            {countOf("UNKNOWN") + countOf("IN_FLIGHT") > 0 && (
              <span className="rounded-full bg-purple-100 px-2.5 py-1 font-medium text-purple-700">
                {countOf("UNKNOWN") + countOf("IN_FLIGHT")} need reconcile
              </span>
            )}
          </div>
          <Link href="/review" className="mt-2 inline-block text-xs text-sky-600 hover:underline">
            open Review &amp; Push →
          </Link>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Last sync per entity
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {["ITEM", "VENDOR", "CUSTOMER", "PO", "SO"].map((e) => {
              const s = lastSyncByEntity.get(e);
              return (
                <li key={e} className="flex items-center gap-2">
                  <span className="w-20 font-mono text-neutral-500">{e}</span>
                  {s ? (
                    <>
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          s.status === "DONE"
                            ? "bg-brand/20 text-brand-800"
                            : s.status === "ERROR"
                              ? "bg-red-100 text-red-700"
                              : "bg-amber-100 text-amber-700",
                        )}
                      >
                        {s.status}
                      </span>
                      <span className="text-neutral-400">
                        {s.rowsPulled} rows · {ist(s.finishedAt ?? s.startedAt)}
                      </span>
                    </>
                  ) : (
                    <span className="text-neutral-300">never</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* pushes needing attention */}
      {problemPushes.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-amber-200 bg-white shadow-sm">
          <div className="border-b border-amber-100 bg-amber-50/60 px-4 py-2 text-sm font-medium text-amber-800">
            Pushes needing attention ({problemPushes.length})
          </div>
          <table className="w-full text-sm">
            <tbody>
              {problemPushes.map((p) => (
                <tr key={p.id} className="border-t border-neutral-50 align-top">
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-600">
                    {p.kind} · {p.docType} #{p.docId}
                    {p.subKey !== "doc" ? ` · ${p.subKey}` : ""}
                  </td>
                  <td className="px-4 py-1.5">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        p.status === "FAILED"
                          ? "bg-red-100 text-red-700"
                          : "bg-purple-100 text-purple-700",
                      )}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="max-w-md px-4 py-1.5 text-xs text-neutral-500">
                    <span className="line-clamp-2">{p.error ?? "—"}</span>
                  </td>
                  <td className="px-4 py-1.5 text-right text-xs text-neutral-400">
                    {p.attempts}× · {ist(p.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* error stream */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-700">System log</h2>
          <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
            {(["ALL", "WARN", "ERROR"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setLevel(k)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium",
                  level === k ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500",
                )}
              >
                {k === "ALL" ? "All" : k === "WARN" ? "Warnings+" : "Errors"}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          {filteredLogs.length === 0 && (
            <p className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-400 shadow-sm">
              Nothing logged {level !== "ALL" ? "at this level " : ""}yet — that's a good sign. ✓
            </p>
          )}
          {filteredLogs.map((l) => (
            <LogCard key={l.id} l={l} onCopy={() => copyBundle(l)} copied={copied === l.id} />
          ))}
        </div>
      </div>
    </div>
  );
}

function LogCard({ l, onCopy, copied }: { l: LogRow; onCopy: () => void; copied: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_CHIP[l.level] ?? LEVEL_CHIP.INFO}`}
        >
          {l.level}
        </span>
        <span className="font-mono text-xs text-neutral-500">{l.source}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">{l.message}</span>
        <span className="text-[11px] text-neutral-400">{ist(l.createdAt)}</span>
        <button
          type="button"
          onClick={onCopy}
          className="rounded border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-50"
          title="Copies time, source, message and full context — paste it straight to Claude"
        >
          {copied ? "Copied ✓" : "Copy for Claude"}
        </button>
        {l.ctx != null && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-sky-600 hover:underline"
          >
            {open ? "hide" : "context"}
          </button>
        )}
      </div>
      {open && l.ctx != null && (
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-600">
          {JSON.stringify(l.ctx, null, 2)}
        </pre>
      )}
    </div>
  );
}
