"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Tabs, type TabDef } from "@/components/Tabs";
import type {
  DashboardInventory,
  MotherGroup,
  MotherRow,
  ZohoOnlyRow,
} from "@/lib/dashboard";
import { D } from "@/lib/money";
import { cn } from "@/lib/utils";
import { refreshIfHealthy } from "@/lib/refresh";

type TabKey = "receiving" | "cold" | "finished";

const CHANNEL_LABEL: Record<string, string> = {
  BULK_FRUIT: "Bulk Fruit",
  BLINKIT: "Blinkit",
  SPENCERS: "Spencer's",
  OTHER: "Other",
  MOTHER: "",
};

/** Live Inventory v3: three in-page subtabs (Receiving · Cold Storage ·
 *  Finished Goods), mother SKUs first, the whole Zoho catalog visible, and
 *  the 7-day grade split in cold storage. Auto-refreshes while visible. */
export function DashboardClient({ data }: { data: DashboardInventory }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("cold");
  const [q, setQ] = useState("");

  // refresh server data every 15s while the tab is visible (same pattern as
  // the pick list — replaces the old /api/stock client-merge polling)
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void refreshIfHealthy(router);
    }, 15_000);
    return () => clearInterval(t);
  }, [router]);

  const term = q.trim().toLowerCase();
  const match = (...vals: (string | null | undefined)[]) =>
    !term || vals.some((v) => v?.toLowerCase().includes(term));

  const bay = useMemo(
    () => data.bay.filter((r) => match(r.code, r.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.bay, term],
  );
  const mothers = useMemo(
    () => data.mothers.filter((r) => match(r.code, r.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.mothers, term],
  );
  const finished = useMemo(
    () =>
      data.finished
        .map((g) => ({
          ...g,
          packs: g.packs.filter((p) =>
            match(p.code, p.name, g.motherCode, g.motherName, p.packSize),
          ),
        }))
        .filter((g) => g.packs.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.finished, term],
  );
  const zohoOnly = useMemo(
    () => data.zohoOnly.filter((r) => match(r.skuText, r.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.zohoOnly, term],
  );

  const tabs: TabDef<TabKey>[] = [
    { key: "receiving", label: "Receiving", badge: data.bay.length, tone: "amber" },
    {
      key: "cold",
      label: "Cold Storage · Raw",
      badge: data.mothers.filter((m) => D(m.coldQty).gt(0)).length,
      tone: "brand",
    },
    {
      key: "finished",
      label: "Finished Goods",
      badge: data.finished.reduce((n, g) => n + g.packs.length, 0),
    },
  ];

  const lastSync = data.summary.lastItemSync
    ? new Date(data.summary.lastItemSync).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="space-y-4">
      {/* summary strip */}
      <div className="grid grid-cols-3 gap-2 md:max-w-xl">
        <SummaryStat label="In receiving bay" value={data.summary.bayKg} unit="kg" tone="amber" />
        <SummaryStat label="Cold room raw" value={data.summary.coldKg} unit="kg" tone="brand" />
        <SummaryStat label="Packs ready" value={data.summary.packUnits} unit="units" tone="neutral" />
      </div>

      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <Tabs tabs={tabs} active={tab} onChange={setTab} className="md:flex-1" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search item, code…"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-brand-600 md:w-64 md:py-1.5 md:text-sm"
        />
      </div>

      {tab === "receiving" && <ReceivingTab bay={bay} />}
      {tab === "cold" && <ColdTab mothers={mothers} lastSync={lastSync} />}
      {tab === "finished" && (
        <FinishedTab groups={finished} zohoOnly={zohoOnly} lastSync={lastSync} />
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  tone: "amber" | "brand" | "neutral";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "amber" && "border-amber-200 bg-amber-50/60",
        tone === "brand" && "border-brand/40 bg-brand/10",
        tone === "neutral" && "border-neutral-200 bg-white",
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-lg font-semibold text-ink">
        {Number(value).toLocaleString("en-IN")}
        <span className="ml-1 text-xs font-normal text-neutral-400">{unit}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Receiving */

function ReceivingTab({ bay }: { bay: DashboardInventory["bay"] }) {
  if (!bay.length)
    return (
      <p className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-400 shadow-sm">
        Receiving bay is empty — everything has been sorted into the cold room. ✓
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-amber-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-amber-50/60 text-left text-xs uppercase tracking-wide text-amber-700">
          <tr>
            <th className="px-4 py-2 font-medium">SKU</th>
            <th className="px-4 py-2 font-medium">Item</th>
            <th className="px-4 py-2 text-right font-medium">Waiting to sort</th>
            <th className="px-4 py-2 font-medium">UOM</th>
          </tr>
        </thead>
        <tbody>
          {bay.map((r) => (
            <tr key={r.skuId} className="border-t border-neutral-50">
              <td className="px-4 py-1.5">
                <SkuLink id={r.skuId} code={r.code} />
              </td>
              <td className="px-4 py-1.5 text-neutral-700">{r.name}</td>
              <td className="px-4 py-1.5 text-right font-mono font-semibold text-amber-700">
                {r.qty}
              </td>
              <td className="px-4 py-1.5 text-neutral-500">{r.uom}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------- Cold storage */

function ColdTab({ mothers, lastSync }: { mothers: MotherRow[]; lastSync: string | null }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const stocked = mothers.filter(
    (m) => D(m.coldQty).gt(0) || m.grade7d != null || D(m.zohoQty ?? "0").gt(0),
  );
  const restCount = mothers.length - stocked.length;
  const rows = showEmpty ? mothers : stocked;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Mother SKU</th>
              <th className="px-4 py-2 font-medium">Fruit</th>
              <th className="px-4 py-2 text-right font-medium">Cold room</th>
              <th className="px-4 py-2 text-right font-medium">Zoho</th>
              <th className="px-2 py-2 text-center font-medium text-brand-800">A</th>
              <th className="px-2 py-2 text-center font-medium text-sky-700">B</th>
              <th className="px-2 py-2 text-center font-medium text-amber-700">C</th>
              <th className="px-2 py-2 text-center font-medium text-red-600">Waste</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-neutral-400">
                  Nothing in the cold room yet
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={m.skuId} className="border-t border-neutral-50">
                <td className="px-4 py-1.5">
                  <SkuLink id={m.skuId} code={m.code} />
                </td>
                <td className="px-4 py-1.5 text-neutral-700">{m.name}</td>
                <td
                  className={cn(
                    "px-4 py-1.5 text-right font-mono font-semibold",
                    D(m.coldQty).gt(0) ? "text-ink" : "text-neutral-300",
                  )}
                >
                  {m.coldQty}
                </td>
                <td className="px-4 py-1.5 text-right font-mono text-neutral-400">
                  {m.zohoQty ?? "—"}
                </td>
                <GradeCells g={m.grade7d} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3">
        {restCount > 0 && (
          <button
            type="button"
            onClick={() => setShowEmpty((v) => !v)}
            className="text-xs text-sky-600 hover:underline"
          >
            {showEmpty ? "Hide" : "Show"} {restCount} fruit(s) with no stock
          </button>
        )}
        <p className="ml-auto text-right text-xs text-neutral-400">
          Grade columns = what was graded IN over the last 7 days (blank if nothing was graded),
          not live per-grade stock.
          {lastSync ? ` Zoho figures as of ${lastSync}.` : ""}
        </p>
      </div>
    </div>
  );
}

function GradeCells({ g }: { g: MotherRow["grade7d"] }) {
  if (!g)
    return (
      <>
        <td className="px-2 py-1.5 text-center text-neutral-200">—</td>
        <td className="px-2 py-1.5 text-center text-neutral-200">—</td>
        <td className="px-2 py-1.5 text-center text-neutral-200">—</td>
        <td className="px-2 py-1.5 text-center text-neutral-200">—</td>
      </>
    );
  const cell = (v: string, cls: string, key: string) => (
    <td
      key={key}
      className={cn(
        "px-2 py-1.5 text-center font-mono text-xs",
        D(v).gt(0) ? cls : "text-neutral-300",
      )}
    >
      {v}
    </td>
  );
  return (
    <>
      {cell(g.a, "text-brand-800", "a")}
      {cell(g.b, "text-sky-700", "b")}
      {cell(g.c, "text-amber-700", "c")}
      {cell(g.waste, "text-red-600", "w")}
    </>
  );
}

/* --------------------------------------------------------- Finished goods */

function FinishedTab({
  groups,
  zohoOnly,
  lastSync,
}: {
  groups: MotherGroup[];
  zohoOnly: ZohoOnlyRow[];
  lastSync: string | null;
}) {
  return (
    <div className="space-y-3">
      {groups.length === 0 && (
        <p className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-400 shadow-sm">
          No packs made yet
        </p>
      )}
      {groups.map((g) => (
        <div
          key={g.motherSkuId ?? "none"}
          className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-neutral-100 bg-neutral-50/60 px-4 py-2">
            <div>
              <span className="font-mono text-xs font-semibold text-neutral-600">
                {g.motherCode}
              </span>{" "}
              <span className="text-sm text-neutral-700">{g.motherName}</span>
            </div>
            <span className="font-mono text-sm font-semibold text-ink">
              {g.totalUnits}
              <span className="ml-1 text-xs font-normal text-neutral-400">units</span>
            </span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {g.packs.map((p) => (
                <tr key={p.skuId} className="border-t border-neutral-50 first:border-t-0">
                  <td className="py-1.5 pl-6 pr-4">
                    <SkuLink id={p.skuId} code={p.code} />
                  </td>
                  <td className="px-4 py-1.5 text-neutral-700">{p.name}</td>
                  <td className="px-4 py-1.5 text-xs text-neutral-400">
                    {p.packSize ?? ""}
                    {p.packSize && CHANNEL_LABEL[p.channel] ? " · " : ""}
                    {CHANNEL_LABEL[p.channel]}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-1.5 text-right font-mono font-semibold",
                      D(p.fgQty).gt(0) ? "text-ink" : "text-neutral-300",
                    )}
                  >
                    {p.fgQty}
                  </td>
                  <td className="py-1.5 pl-2 pr-4 text-right font-mono text-xs text-neutral-400">
                    {p.zohoQty != null ? `Zoho ${p.zohoQty}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {zohoOnly.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-dashed border-neutral-300 bg-white shadow-sm">
          <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-2 text-sm text-neutral-500">
            Other items in Zoho ({zohoOnly.length}) — not tracked in this app
            {lastSync ? ` · as of ${lastSync}` : ""}
          </div>
          <table className="w-full text-sm">
            <tbody>
              {zohoOnly.map((r) => (
                <tr key={r.zohoItemId} className="border-t border-neutral-50 first:border-t-0">
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-400">
                    {r.skuText || "—"}
                  </td>
                  <td className="px-4 py-1.5 text-neutral-500">{r.name}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-neutral-400">{r.stock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SkuLink({ id, code }: { id: number; code: string }) {
  return (
    <Link
      href={`/dashboard/sku/${id}`}
      className="font-mono text-xs font-medium text-sky-700 hover:underline"
    >
      {code}
    </Link>
  );
}
