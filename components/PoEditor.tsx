"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { savePoDraft, pushPoDraft, updateZohoPo } from "@/actions/po";
import { ZOHO_PUSH_LABELS } from "@/lib/zoho/labels";
import { newToken } from "@/lib/utils";

type Sku = { id: number; code: string; name: string; uom: string };
type Vendor = { id: number; name: string; vendorZohoId: string };

type DraftLine = { skuId: string; qty: string; rate: string };

/* ------------------------------------------------ New PO (local → draft) */

export function NewPoEditor({ vendors, skus }: { vendors: Vendor[]; skus: Sku[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [vendorZohoId, setVendorZohoId] = useState<string | null>(null);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ skuId: "", qty: "", rate: "" }]);
  const [docId, setDocId] = useState<number | null>(null);
  const [zohoPoId, setZohoPoId] = useState<string | null>(null);
  const tokenRef = useRef(newToken());

  const vendorOpts: Option[] = vendors.map((v) => ({
    value: v.vendorZohoId,
    label: v.name,
  }));
  const skuOpts: Option[] = skus.map((k) => ({
    value: String(k.id),
    code: k.code,
    label: k.name,
    hint: k.uom,
  }));
  const skuById = new Map(skus.map((k) => [k.id, k]));
  const vendorName = vendors.find((v) => v.vendorZohoId === vendorZohoId)?.name;

  function setLine(i: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function save(thenPush: boolean) {
    setMsg(null);
    const filled = lines.filter((l) => l.skuId && Number(l.qty) > 0);
    if (!vendorZohoId) return setMsg({ type: "err", text: "Pick a vendor first." });
    if (!filled.length) return setMsg({ type: "err", text: "Add at least one line." });
    start(async () => {
      const res = await savePoDraft({
        docId: docId ?? undefined,
        clientToken: tokenRef.current,
        vendorZohoId,
        vendorName,
        deliveryDate: deliveryDate || undefined,
        note: note || undefined,
        lines: filled.map((l) => ({
          skuId: Number(l.skuId),
          qty: l.qty,
          rate: l.rate || undefined,
          uom: (skuById.get(Number(l.skuId))?.uom ?? "kg") as
            | "kg" | "g" | "pc" | "box" | "bunch" | "unit",
        })),
      });
      if (!res.ok) return setMsg({ type: "err", text: res.error });
      setDocId(res.docId);
      if (!thenPush) {
        setMsg({ type: "ok", text: `Draft #${res.docId} saved locally ✓` });
        return;
      }
      const push = await pushPoDraft(res.docId);
      if (!push.ok) return setMsg({ type: "err", text: push.error });
      setZohoPoId(push.zohoPoId ?? null);
      setMsg({
        type: "ok",
        text: `Pushed to Zoho as draft PO${push.zohoPoId ? ` (${push.zohoPoId})` : ""} ✓`,
      });
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500">Vendor</span>
          <SearchSelect
            options={vendorOpts}
            value={vendorZohoId}
            onChange={setVendorZohoId}
            placeholder="Pick a vendor…"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500">Delivery date</span>
          <input
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500">Note</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </label>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-right font-medium">Rate (₹, optional)</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-neutral-50 align-top">
                <td className="min-w-64 px-3 py-1.5">
                  <SearchSelect
                    options={skuOpts}
                    value={l.skuId || null}
                    onChange={(v) => setLine(i, { skuId: v ?? "" })}
                    placeholder="Pick an item…"
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.001"
                    value={l.qty}
                    onChange={(e) => setLine(i, { qty: e.target.value })}
                    className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={l.rate}
                    onChange={(e) => setLine(i, { rate: e.target.value })}
                    className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                  />
                </td>
                <td className="px-3 py-1.5">
                  <button
                    type="button"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, x) => x !== i) : ls))}
                    className="text-xs text-neutral-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => setLines((ls) => [...ls, { skuId: "", qty: "", rate: "" }])}
        className="mt-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
      >
        + Add line
      </button>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => save(false)}
          disabled={pending || !!zohoPoId}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save draft locally"}
        </button>
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => save(true)}
            disabled={pending || !!zohoPoId}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {pending ? "Working…" : "Save + push to Zoho"}
          </button>
          <span className="mt-1 text-xs text-neutral-400">
            {ZOHO_PUSH_LABELS["podraft.create"]}
          </span>
        </div>
        {msg && (
          <p className={msg.type === "ok" ? "text-sm text-brand-800" : "text-sm text-red-600"}>
            {msg.text}
          </p>
        )}
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        Keep editing and re-saving while you confirm quantities with the vendor on the phone —
        push once you&apos;re ready. The PO lands in Zoho as a <b>draft</b>, never issued.
      </p>
    </div>
  );
}

/* -------------------------------------------- Edit a live (open) Zoho PO */

export type ZohoPoLine = {
  lineItemId: string;
  name: string;
  sku: string;
  quantity: number;
  rate: number | null;
};

export function EditPoEditor({
  zohoPoId,
  poNumber,
  vendorName,
  lines,
}: {
  zohoPoId: string;
  poNumber: string;
  vendorName: string;
  lines: ZohoPoLine[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.lineItemId, String(l.quantity)])),
  );
  const [deliveryDate, setDeliveryDate] = useState("");

  function save() {
    const changed = lines
      .filter((l) => qty[l.lineItemId] !== String(l.quantity))
      .map((l) => ({ lineItemId: l.lineItemId, quantity: qty[l.lineItemId] }));
    if (!changed.length && !deliveryDate) {
      setMsg({ type: "err", text: "Nothing changed." });
      return;
    }
    if (
      !window.confirm(
        `This edits the LIVE purchase order ${poNumber} in Zoho (${changed.length} line(s)). Continue?`,
      )
    )
      return;
    setMsg(null);
    start(async () => {
      const res = await updateZohoPo({
        zohoPoId,
        deliveryDate: deliveryDate || undefined,
        lines: changed,
      });
      if (res.ok) {
        setMsg({ type: "ok", text: "Zoho PO updated ✓ (receiving sheet refreshed)" });
        router.refresh();
      } else {
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-neutral-500">{poNumber}</span>
        <span className="font-medium text-neutral-800">{vendorName}</span>
        <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700">
          {ZOHO_PUSH_LABELS["po.update"]}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Current qty</th>
            <th className="px-3 py-2 text-right font-medium">New qty</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const dirty = qty[l.lineItemId] !== String(l.quantity);
            return (
              <tr key={l.lineItemId} className="border-t border-neutral-50">
                <td className="px-3 py-1.5">
                  <span className="font-mono text-xs text-neutral-500">{l.sku}</span>{" "}
                  <span className="text-neutral-700">{l.name}</span>
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-neutral-500">
                  {l.quantity}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.001"
                    value={qty[l.lineItemId] ?? ""}
                    onChange={(e) =>
                      setQty((q) => ({ ...q, [l.lineItemId]: e.target.value }))
                    }
                    className={`w-28 rounded border px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 ${
                      dirty ? "border-amber-400 bg-amber-50" : "border-neutral-300"
                    }`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500">
            New delivery date (optional)
          </span>
          <input
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {pending ? "Updating Zoho…" : "Save to Zoho"}
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
