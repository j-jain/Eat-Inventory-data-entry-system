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
  const [at, setAt] = useState<string>(new Date().toLocaleTimeString());

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

  const cold = filtered.filter((r) => r.locationCode === "COLD_ROOM");
  const fg = filtered.filter((r) => r.locationCode === "DC_FLOOR_FG");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by code, name or channel…"
          className="w-72 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <span className="text-xs text-neutral-400">
          live · {filtered.length} rows · updated {at}
        </span>
      </div>

      <StockTable title="Cold Room (raw mother stock)" rows={cold} />
      <StockTable title="Finished Goods (packs)" rows={fg} />
    </div>
  );
}

function StockTable({ title, rows }: { title: string; rows: LiveStockRow[] }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-100 px-4 py-2.5 text-sm font-semibold text-neutral-700">
        {title} <span className="font-normal text-neutral-400">· {rows.length}</span>
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
                  className="font-mono text-xs text-emerald-700 hover:underline"
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
