"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LiveStockRow } from "@/lib/ledger/balance";

const CHANNEL_LABEL: Record<string, string> = {
  MOTHER: "Mother (raw)",
  BULK_FRUIT: "Bulk Fruit",
  BLINKIT: "Blinkit",
  SPENCERS: "Spencer's",
  OTHER: "Other",
};

export function DashboardClient({ initial }: { initial: LiveStockRow[] }) {
  const [rows, setRows] = useState<LiveStockRow[]>(initial);
  const [q, setQ] = useState("");
  const [at, setAt] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/stock", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) {
          setRows(data.rows);
          setAt(new Date().toLocaleTimeString());
        }
      } catch {
        /* ignore transient network errors */
      }
    };
    tick(); // refresh on mount (also stamps the "updated" time, client-side only)
    const id = setInterval(tick, 12000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const term = q.trim().toLowerCase();
  const filtered = term
    ? rows.filter(
        (r) =>
          r.code.toLowerCase().includes(term) ||
          r.name.toLowerCase().includes(term) ||
          CHANNEL_LABEL[r.channel]?.toLowerCase().includes(term),
      )
    : rows;

  const bay = filtered.filter((r) => r.locationCode === "RECEIVING_BAY");
  const cold = filtered.filter((r) => r.locationCode === "COLD_ROOM");
  const fg = filtered.filter((r) => r.locationCode === "DC_FLOOR_FG");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by code, name or channel…"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-brand-600 sm:w-72 sm:py-1.5 sm:text-sm"
        />
        <span className="text-xs text-neutral-400">
          live · {filtered.length} rows · updated {at || "…"}
        </span>
      </div>

      {bay.length > 0 && (
        <StockTable
          title="Receiving Bay (waiting to be sorted)"
          rows={bay}
          highlight
        />
      )}
      <StockTable title="Cold Room (raw mother stock)" rows={cold} />
      <StockTable title="Finished Goods (packs)" rows={fg} />
    </div>
  );
}

function StockTable({
  title,
  rows,
  highlight,
}: {
  title: string;
  rows: LiveStockRow[];
  highlight?: boolean;
}) {
  return (
    <div
      className={`overflow-x-auto rounded-xl border bg-white shadow-sm ${
        highlight ? "border-amber-300" : "border-neutral-200"
      }`}
    >
      <div
        className={`border-b px-4 py-2.5 text-sm font-semibold ${
          highlight
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "border-neutral-100 text-neutral-700"
        }`}
      >
        {title} <span className="font-normal opacity-60">· {rows.length}</span>
        {highlight && (
          <span className="ml-2 text-xs font-normal">
            — sort these to move them into the Cold Room
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
          <tr>
            <th className="px-4 py-2 font-medium">SKU</th>
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Channel</th>
            <th className="px-4 py-2 text-right font-medium">Qty</th>
            <th className="px-4 py-2 font-medium">UOM</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-sm text-neutral-400">
                No stock
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.skuId}-${r.locationId}`} className="border-t border-neutral-50 hover:bg-neutral-50">
              <td className="px-4 py-1.5">
                <Link
                  href={`/dashboard/sku/${r.skuId}`}
                  className="font-mono text-xs text-brand-800 hover:underline"
                >
                  {r.code}
                </Link>
              </td>
              <td className="px-4 py-1.5 text-neutral-700">{r.name}</td>
              <td className="px-4 py-1.5 text-neutral-500">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
              <td className="px-4 py-1.5 text-right font-mono">{Number(r.qty).toFixed(3)}</td>
              <td className="px-4 py-1.5 text-neutral-500">{r.uom}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
