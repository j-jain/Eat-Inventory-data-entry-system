"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { submitDispatch } from "@/actions/entries";
import { markDelivered } from "@/actions/dispatch";
import type { DispatchPrelistRow, TodayDispatchRow } from "@/lib/queries";
import { newToken } from "@/lib/utils";
import { D } from "@/lib/money";

type Channel = "BULK_FRUIT" | "BLINKIT" | "SPENCERS";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "BULK_FRUIT", label: "Bulk Fruit" },
  { value: "BLINKIT", label: "Blinkit" },
  { value: "SPENCERS", label: "Spencer's" },
];

/* --------------------------------------------------------- Dispatch form */

export function DispatchForm({
  prelist,
  customers,
}: {
  prelist: DispatchPrelistRow[];
  customers: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [channel, setChannel] = useState<Channel | "">("");
  const [dispatchRef, setDispatchRef] = useState("");
  // qty per skuId, defaulting to remaining
  const [qty, setQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(prelist.map((r) => [r.skuId, r.remainingQty])),
  );
  const tokenRef = useRef(newToken());

  const customerOpts: Option[] = customers.map((c) => ({ value: String(c.id), label: c.name }));
  const uomBySku = new Map(prelist.map((r) => [r.skuId, r.uom]));

  function submit() {
    setMsg(null);
    const lines = prelist
      .map((r) => ({
        packSkuId: r.skuId,
        qty: qty[r.skuId] ?? "0",
        uom: (uomBySku.get(r.skuId) ?? "pc") as "kg" | "g" | "pc" | "box" | "bunch" | "unit",
      }))
      .filter((l) => Number(l.qty) > 0);
    if (lines.length === 0) {
      setMsg({ type: "err", text: "Enter a quantity on at least one line." });
      return;
    }
    start(async () => {
      const res = await submitDispatch({
        clientToken: tokenRef.current,
        customerId: customerId ?? undefined,
        channel: channel || undefined,
        dispatchRef: dispatchRef.trim() || undefined,
        lines,
      });
      if (res.ok) {
        setMsg({ type: "ok", text: "Dispatch saved ✓" });
        tokenRef.current = newToken();
        router.refresh();
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Customer (optional)">
          <SearchSelect
            options={customerOpts}
            value={customerId != null ? String(customerId) : null}
            onChange={(v) => setCustomerId(v != null ? Number(v) : null)}
            placeholder="Pick a customer…"
          />
        </Field>
        <Field label="Channel (optional)">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel | "")}
            className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          >
            <option value="">—</option>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Dispatch ref (optional)">
          <input
            value={dispatchRef}
            onChange={(e) => setDispatchRef(e.target.value)}
            placeholder="e.g. TRIP-07"
            className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </Field>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 text-right font-medium">Picked</th>
              <th className="px-3 py-2 text-right font-medium">Dispatched</th>
              <th className="px-3 py-2 text-right font-medium">Remaining</th>
              <th className="px-3 py-2 text-right font-medium">Qty to dispatch</th>
            </tr>
          </thead>
          <tbody>
            {prelist.map((r) => {
              const zero = D(r.remainingQty).lte(0);
              return (
                <tr
                  key={r.skuId}
                  className={`border-t border-neutral-50 ${zero ? "bg-neutral-50 text-neutral-400" : ""}`}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-neutral-500">{r.code}</span>{" "}
                    <span className={zero ? "text-neutral-400" : "text-neutral-700"}>{r.name}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.pickedQty}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.dispatchedToday}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.remainingQty} {r.uom}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.001"
                      disabled={zero}
                      value={qty[r.skuId] ?? ""}
                      onChange={(e) =>
                        setQty((q) => ({ ...q, [r.skuId]: e.target.value }))
                      }
                      className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 disabled:bg-neutral-100"
                    />
                  </td>
                </tr>
              );
            })}
            {prelist.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-neutral-400">
                  Nothing picked to dispatch.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-neutral-400">
        Dispatch is pick-list-driven — rows come from today&apos;s completed pick list, so there is
        no add-row. Lines with nothing remaining are greyed out.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || prelist.length === 0}
          className="rounded-md bg-brand px-5 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save dispatch"}
        </button>
        {msg && (
          <p className={msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- Delivery section */

const STATUS_CHIP: Record<string, string> = {
  PENDING: "bg-neutral-100 text-neutral-600",
  PARTIAL: "bg-amber-100 text-amber-700",
  DELIVERED: "bg-brand/25 text-brand-800",
};

export function DeliveryList({ dispatches }: { dispatches: TodayDispatchRow[] }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-neutral-700">
        Today&apos;s dispatches{" "}
        <span className="font-normal text-neutral-400">· {dispatches.length}</span>
      </h2>
      {dispatches.length === 0 ? (
        <p className="text-sm text-neutral-400">No dispatches today yet.</p>
      ) : (
        <div className="space-y-3">
          {dispatches.map((d) => (
            <DeliveryCard key={d.docId} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}

const CHANNEL_LABEL: Record<string, string> = {
  BULK_FRUIT: "Bulk Fruit",
  BLINKIT: "Blinkit",
  SPENCERS: "Spencer's",
  MOTHER: "Mother",
  OTHER: "Other",
};

function DeliveryCard({ d }: { d: TodayDispatchRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [delivered, setDelivered] = useState<Record<number, string>>(() =>
    Object.fromEntries(d.lines.map((l) => [l.lineId, l.deliveredQty])),
  );
  const [note, setNote] = useState(d.deliveryNote ?? "");

  function confirm() {
    setMsg(null);
    start(async () => {
      const res = await markDelivered({
        docId: d.docId,
        note: note.trim() || undefined,
        lines: d.lines.map((l) => ({
          lineId: l.lineId,
          deliveredQty: delivered[l.lineId] ?? "0",
        })),
      });
      if (res.ok) {
        setMsg({ type: "ok", text: `Marked ${res.status.toLowerCase()} ✓` });
        router.refresh();
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono text-xs text-neutral-500">#{d.docId}</span>
          <span className="font-medium text-neutral-800">{d.customerName ?? "No customer"}</span>
          {d.channel && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
              {CHANNEL_LABEL[d.channel] ?? d.channel}
            </span>
          )}
          {d.dispatchRef && <span className="text-xs text-neutral-500">ref {d.dispatchRef}</span>}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[d.deliveryStatus] ?? STATUS_CHIP.PENDING}`}
        >
          {d.deliveryStatus}
        </span>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="py-1 font-medium">SKU</th>
              <th className="py-1 text-right font-medium">Dispatched</th>
              <th className="py-1 text-right font-medium">Delivered</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.lineId} className="border-t border-neutral-50">
                <td className="py-1.5">
                  <span className="font-mono text-xs text-neutral-500">{l.code}</span>{" "}
                  <span className="text-neutral-700">{l.name}</span>
                </td>
                <td className="py-1.5 text-right font-mono text-neutral-600">
                  {l.qty} {l.uom}
                </td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.001"
                    value={delivered[l.lineId] ?? ""}
                    onChange={(e) =>
                      setDelivered((s) => ({ ...s, [l.lineId]: e.target.value }))
                    }
                    className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Delivery note (optional)"
          className="min-w-40 flex-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        <button
          type="button"
          onClick={confirm}
          disabled={pending}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-ink hover:bg-brand-600 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Confirm delivery"}
        </button>
        {msg && (
          <p className={msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </div>
  );
}
