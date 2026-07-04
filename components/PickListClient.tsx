"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  generatePickList,
  updatePickProgress,
  completePickList,
  cancelPickList,
} from "@/actions/pick-list";
import type { PickListDetail, PickListLineRow } from "@/lib/queries";
import type { PickGate } from "@/lib/workflow";
import { newToken } from "@/lib/utils";
import { D } from "@/lib/money";

type Msg = { type: "ok" | "err"; text: string } | null;

export function PickListClient({
  gate,
  list,
  isSupervisor,
}: {
  gate: PickGate;
  list: PickListDetail | null;
  isSupervisor: boolean;
}) {
  const router = useRouter();

  // Poll for freshness (paused when the tab is hidden).
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 10000);
    return () => clearInterval(id);
  }, [router]);

  if (list && list.status === "OPEN") {
    return <OpenList list={list} isSupervisor={isSupervisor} />;
  }
  if (list && list.status === "COMPLETED") {
    return <CompletedCard list={list} />;
  }
  // NO_PICK_LIST (or a stale OPEN from a prior day that isn't the loaded list)
  return <GenerateCard gate={gate} />;
}

/* ---------------------------------------------------------------- Generate */

function GenerateCard({ gate }: { gate: PickGate }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const tokenRef = useRef(newToken());
  const hasOpen = gate.state === "OPEN";

  function generate() {
    setMsg(null);
    start(async () => {
      const res = await generatePickList(tokenRef.current);
      if (res.ok) {
        if (res.empty) {
          setMsg({
            type: "ok",
            text: "No open orders — pick list completed automatically ✓",
          });
        }
        tokenRef.current = newToken();
        router.refresh();
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="max-w-md text-sm text-neutral-500">
          Aggregate every open order (Zoho sales orders + manual orders) into one
          pick list of packs to pull. Generating is mandatory before any Assembly
          or Dispatch work — and it re-locks them until the new list is completed.
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={pending || hasOpen}
          className="rounded-md bg-brand px-6 py-2.5 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate Pick List"}
        </button>
        {hasOpen && (
          <p className="text-xs text-amber-700">
            A pick list is already open — finish or cancel it first.
          </p>
        )}
        {msg && (
          <p className={msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Open list */

type LineState = PickListLineRow & { savedPicked: string };

function OpenList({
  list,
  isSupervisor,
}: {
  list: PickListDetail;
  isSupervisor: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [lines, setLines] = useState<LineState[]>(() =>
    list.lines.map((l) => ({ ...l, savedPicked: l.qtyPicked })),
  );

  // Adopt fresh server data during render (poll / navigation) without an
  // effect — the documented "adjust state when props change" pattern. A line
  // the user is mid-edit on (qtyPicked !== savedPicked) is left untouched.
  const [seenServerLines, setSeenServerLines] = useState(list.lines);
  if (seenServerLines !== list.lines) {
    setSeenServerLines(list.lines);
    const byId = new Map(lines.map((p) => [p.lineId, p]));
    setLines(
      list.lines.map((l) => {
        const cur = byId.get(l.lineId);
        if (cur && cur.qtyPicked !== cur.savedPicked) return cur;
        return { ...l, savedPicked: l.qtyPicked };
      }),
    );
  }

  const yetToPick = (l: LineState) => {
    const d = D(l.qtyToPick).minus(D(l.qtyPicked));
    return d.gt(0) ? d.toFixed(3) : "0.000";
  };
  const allPicked = lines.every((l) => D(l.qtyPicked).gte(D(l.qtyToPick)));

  const totalToPick = lines.reduce((a, l) => a.plus(D(l.qtyToPick)), D(0));
  const totalPicked = lines.reduce(
    (a, l) => a.plus(D(l.qtyPicked).gt(D(l.qtyToPick)) ? D(l.qtyToPick) : D(l.qtyPicked)),
    D(0),
  );
  const pct = totalToPick.isZero()
    ? 0
    : Math.min(100, Math.round(totalPicked.div(totalToPick).times(100).toNumber()));

  function save(lineId: number, next: string) {
    // clamp 0..toPick locally
    const line = lines.find((l) => l.lineId === lineId);
    if (!line) return;
    let val = next;
    if (D(val || "0").lt(0)) val = "0";
    if (D(val || "0").gt(D(line.qtyToPick))) val = line.qtyToPick;

    const prevSaved = line.savedPicked;
    // optimistic
    setLines((ls) =>
      ls.map((l) => (l.lineId === lineId ? { ...l, qtyPicked: val, savedPicked: val } : l)),
    );
    setMsg(null);
    start(async () => {
      const res = await updatePickProgress({
        pickListId: list.id,
        lineId,
        qtyPicked: val,
      });
      if (!res.ok) {
        // roll back
        setLines((ls) =>
          ls.map((l) =>
            l.lineId === lineId ? { ...l, qtyPicked: prevSaved, savedPicked: prevSaved } : l,
          ),
        );
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  function step(lineId: number, delta: number) {
    const line = lines.find((l) => l.lineId === lineId);
    if (!line) return;
    save(lineId, D(line.qtyPicked).plus(D(delta)).toFixed(3));
  }

  function complete(short: boolean) {
    setMsg(null);
    let shortReason: string | undefined;
    if (short) {
      const r = window.prompt("Reason for completing short (surfaces on the Summary):");
      if (r == null) return;
      if (r.trim().length < 3) {
        setMsg({ type: "err", text: "A reason of at least 3 characters is required." });
        return;
      }
      shortReason = r.trim();
    }
    start(async () => {
      const res = await completePickList(list.id, shortReason ? { shortReason } : undefined);
      if (res.ok) router.refresh();
      else setMsg({ type: "err", text: res.error });
    });
  }

  function cancel() {
    const r = window.prompt("Reason to cancel this pick list:");
    if (r == null) return;
    if (r.trim().length < 3) {
      setMsg({ type: "err", text: "A cancel reason of at least 3 characters is required." });
      return;
    }
    setMsg(null);
    start(async () => {
      const res = await cancelPickList(list.id, r.trim());
      if (res.ok) router.refresh();
      else setMsg({ type: "err", text: res.error });
    });
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-neutral-600">
            Pick list <span className="font-mono text-xs">#{list.id}</span> ·{" "}
            {list.businessDate} ·{" "}
            <span className="text-neutral-400">
              {list.sources.soCount} SO + {list.sources.manualCount} manual
            </span>
          </div>
          <div className="text-sm font-medium text-neutral-700">{pct}% picked</div>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
          <div className="h-2 rounded-full bg-cream0" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">SKU</th>
              <th className="px-4 py-2 text-right font-medium">To pick</th>
              <th className="px-4 py-2 text-right font-medium">Picked</th>
              <th className="px-4 py-2 text-right font-medium">Yet to pick</th>
              <th className="px-4 py-2 text-center font-medium">Adjust</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const done = D(l.qtyPicked).gte(D(l.qtyToPick));
              return (
                <tr key={l.lineId} className="border-t border-neutral-50">
                  <td className="px-4 py-2">
                    <div className="font-mono text-xs text-neutral-600">{l.code}</div>
                    <div className="text-neutral-700">{l.name}</div>
                    {l.motherCode && (
                      <div className="text-xs text-neutral-400">from {l.motherCode}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-neutral-600">
                    {l.qtyToPick} {l.uom}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.001"
                      value={l.qtyPicked}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((x) =>
                            x.lineId === l.lineId ? { ...x, qtyPicked: e.target.value } : x,
                          ),
                        )
                      }
                      onBlur={(e) => save(l.lineId, e.target.value || "0")}
                      className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                    />
                  </td>
                  <td
                    className={`px-4 py-2 text-right font-mono ${done ? "text-brand-700" : "text-amber-600"}`}
                  >
                    {done ? "✓" : yetToPick(l)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => step(l.lineId, -1)}
                        className="h-7 w-7 rounded border border-neutral-300 text-neutral-600 hover:bg-neutral-50"
                        aria-label="decrease by one"
                      >
                        −
                      </button>
                      <button
                        type="button"
                        onClick={() => step(l.lineId, 1)}
                        className="h-7 w-7 rounded border border-neutral-300 text-neutral-600 hover:bg-neutral-50"
                        aria-label="increase by one"
                      >
                        +
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {msg && (
        <p className={msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}>
          {msg.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => complete(false)}
          disabled={pending || !allPicked}
          className="rounded-md bg-brand px-5 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
          title={allPicked ? undefined : "Every line must be fully picked first"}
        >
          Complete Pick List
        </button>
        {isSupervisor && (
          <button
            type="button"
            onClick={() => complete(true)}
            disabled={pending}
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            Complete short…
          </button>
        )}
        {isSupervisor && (
          <button
            type="button"
            onClick={cancel}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
          >
            Cancel list…
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- Completed card */

function CompletedCard({ list }: { list: PickListDetail }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const tokenRef = useRef(newToken());

  function generateAgain() {
    setMsg(null);
    start(async () => {
      const res = await generatePickList(tokenRef.current);
      if (res.ok) {
        if (res.empty) {
          setMsg({
            type: "ok",
            text: "No open orders — pick list completed automatically ✓",
          });
        }
        tokenRef.current = newToken();
        router.refresh();
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-brand-300 bg-cream p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-brand/25 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-brand-800">
            Completed ✓
          </span>
          <span className="font-mono text-xs text-brand-800">#{list.id}</span>
          <span className="text-sm text-brand-800">{list.businessDate}</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-brand-800 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-brand-800">Lines</dt>
            <dd className="font-medium">{list.lines.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-brand-800">Sources</dt>
            <dd className="font-medium">
              {list.sources.soCount} SO · {list.sources.manualCount} manual
            </dd>
          </div>
          <div>
            <dt className="text-xs text-brand-800">Completed by</dt>
            <dd className="font-medium">{list.createdBy ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-brand-800">Note</dt>
            <dd className="font-medium">{list.note ?? "—"}</dd>
          </div>
        </dl>
        {list.shortCompleteReason && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Completed short — reason: {list.shortCompleteReason}
          </div>
        )}
      </div>

      {list.lines.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 text-right font-medium">To pick</th>
                <th className="px-4 py-2 text-right font-medium">Picked</th>
              </tr>
            </thead>
            <tbody>
              {list.lines.map((l) => (
                <tr key={l.lineId} className="border-t border-neutral-50">
                  <td className="px-4 py-1.5">
                    <span className="font-mono text-xs text-neutral-600">{l.code}</span>{" "}
                    <span className="text-neutral-700">{l.name}</span>
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono text-neutral-600">
                    {l.qtyToPick} {l.uom}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono text-neutral-600">
                    {l.qtyPicked}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <p className="mb-2 text-sm text-neutral-500">
          More orders arrived? Generate again — note that regenerating locks
          Assembly and Dispatch until the new list is completed.
        </p>
        <button
          type="button"
          onClick={generateAgain}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate again"}
        </button>
        {msg && (
          <p
            className={`mt-2 ${msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}`}
          >
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}
