"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { submitManualOrder, voidManualOrder } from "@/actions/orders";
import type { SkuOption, ManualOrderRow } from "@/lib/queries";
import { newToken } from "@/lib/utils";

type Uom = "kg" | "g" | "pc" | "box" | "bunch" | "unit";
type Channel = "MOTHER" | "BULK_FRUIT" | "BLINKIT" | "SPENCERS" | "OTHER";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "MOTHER", label: "Mother" },
  { value: "BULK_FRUIT", label: "Bulk Fruit" },
  { value: "BLINKIT", label: "Blinkit" },
  { value: "SPENCERS", label: "Spencer's" },
  { value: "OTHER", label: "Other" },
];

type Row = { key: string; skuId: number | null; qty: string; uom: Uom };

let rowSeq = 0;
const blankRow = (): Row => ({ key: `r${rowSeq++}`, skuId: null, qty: "", uom: "pc" });

export function OrdersClient({
  customers,
  skus,
  orders,
  isSupervisor,
}: {
  customers: { id: number; name: string }[];
  skus: SkuOption[];
  orders: ManualOrderRow[];
  isSupervisor: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [channel, setChannel] = useState<Channel | "">("");
  const [orderRef, setOrderRef] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const tokenRef = useRef(newToken());

  const customerOpts: Option[] = customers.map((c) => ({
    value: String(c.id),
    label: c.name,
  }));
  const skuOpts: Option[] = skus.map((s) => ({
    value: String(s.id),
    label: s.name,
    code: s.code,
    hint: s.packSizeText ?? undefined,
  }));
  const skuById = new Map(skus.map((s) => [s.id, s]));

  function setSku(key: string, skuId: number | null) {
    const sku = skuId != null ? skuById.get(skuId) : undefined;
    setRows((rs) =>
      rs.map((r) =>
        r.key === key
          ? { ...r, skuId, uom: (sku?.uom as Uom) ?? r.uom }
          : r,
      ),
    );
  }

  function submit() {
    setMsg(null);
    const lines = rows
      .filter((r) => r.skuId != null && Number(r.qty) > 0)
      .map((r) => ({ skuId: r.skuId as number, qty: r.qty, uom: r.uom }));
    if (lines.length === 0) {
      setMsg({ type: "err", text: "Add at least one line with a SKU and quantity." });
      return;
    }
    start(async () => {
      const res = await submitManualOrder({
        clientToken: tokenRef.current,
        customerId: customerId ?? undefined,
        channel: channel || undefined,
        orderRef: orderRef.trim() || undefined,
        note: note.trim() || undefined,
        lines,
      });
      if (res.ok) {
        setMsg({ type: "ok", text: "Order saved ✓" });
        tokenRef.current = newToken();
        setCustomerId(null);
        setChannel("");
        setOrderRef("");
        setNote("");
        setRows([blankRow()]);
        router.refresh();
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-neutral-700">New order</h2>
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
          <Field label="Order ref (optional)">
            <input
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
              placeholder="e.g. PHONE-1234"
              className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </Field>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="py-2 font-medium">SKU</th>
                <th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 font-medium">UOM</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-neutral-50">
                  <td className="py-1.5 pr-2">
                    <SearchSelect
                      options={skuOpts}
                      value={r.skuId != null ? String(r.skuId) : null}
                      onChange={(v) => setSku(r.key, v != null ? Number(v) : null)}
                      placeholder="Pick a SKU…"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.001"
                      value={r.qty}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)),
                        )
                      }
                      className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-neutral-500">{r.uom}</td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs))}
                      className="text-xs text-neutral-400 hover:text-red-600"
                      aria-label="remove row"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, blankRow()])}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
          >
            + Add row
          </button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="min-w-40 flex-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-md bg-brand px-5 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save order"}
          </button>
        </div>
        {msg && (
          <p
            className={`mt-2 ${msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}`}
          >
            {msg.text}
          </p>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-700">
          Recent orders <span className="font-normal text-neutral-400">· {orders.length}</span>
        </h2>
        {orders.length === 0 ? (
          <p className="text-sm text-neutral-400">No manual orders yet.</p>
        ) : (
          <div className="space-y-3">
            {orders.map((o) => (
              <OrderCard key={o.id} order={o} isSupervisor={isSupervisor} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const CHANNEL_LABEL: Record<string, string> = {
  MOTHER: "Mother",
  BULK_FRUIT: "Bulk Fruit",
  BLINKIT: "Blinkit",
  SPENCERS: "Spencer's",
  OTHER: "Other",
};

function OrderCard({ order, isSupervisor }: { order: ManualOrderRow; isSupervisor: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function voidOrder() {
    const r = window.prompt("Reason to void this order:");
    if (r == null) return;
    if (r.trim().length < 3) {
      setErr("A void reason of at least 3 characters is required.");
      return;
    }
    setErr(null);
    start(async () => {
      const res = await voidManualOrder(order.id, r.trim());
      if (res.ok) router.refresh();
      else setErr(res.error);
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono text-xs text-neutral-500">#{order.id}</span>
          <span className="font-medium text-neutral-800">{order.customerName ?? "No customer"}</span>
          {order.channel && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
              {CHANNEL_LABEL[order.channel] ?? order.channel}
            </span>
          )}
          {order.orderRef && <span className="text-xs text-neutral-500">ref {order.orderRef}</span>}
          {order.picked && (
            <span className="rounded-full bg-brand/25 px-2 py-0.5 text-xs font-medium text-brand-800">
              picked ✓
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">
            {order.businessDate} · {order.createdBy ?? "—"}
          </span>
          {isSupervisor && !order.picked && (
            <button
              type="button"
              onClick={voidOrder}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
            >
              Void
            </button>
          )}
        </div>
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-neutral-600">
        {order.lines.map((l, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-neutral-500">{l.code}</span>
            <span className="text-neutral-700">{l.name}</span>
            <span className="ml-auto font-mono text-neutral-600">
              {l.qty} {l.uom}
            </span>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
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
