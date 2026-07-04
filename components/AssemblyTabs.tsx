"use client";

import { useState } from "react";
import { EntryForm, type SkuOpt } from "@/components/EntryForm";
import { submitAssembly } from "@/actions/entries";

type Channel = "BULK_FRUIT" | "BLINKIT" | "SPENCERS";
const TABS: { key: Channel; label: string }[] = [
  { key: "BLINKIT", label: "Blinkit (BZ)" },
  { key: "SPENCERS", label: "Spencer's (S)" },
  { key: "BULK_FRUIT", label: "Bulk Fruit (BF)" },
];

export function AssemblyTabs({
  motherSkus,
  packsByChannel,
  pickLines,
  allowAddRow,
  canPushToZoho,
  pushLabel,
  wasteReasons,
}: {
  motherSkus: SkuOpt[];
  packsByChannel: Record<Channel, SkuOpt[]>;
  /** Today's completed pick list (pack SKU + qty needed) — drives the prelist. */
  pickLines: { skuId: number; need: string; code: string }[];
  allowAddRow: boolean;
  canPushToZoho: boolean;
  pushLabel: string;
  wasteReasons: { code: string; label: string }[];
}) {
  const [tab, setTab] = useState<Channel>("BLINKIT");

  // Pre-list ONLY the picked packs belonging to the active channel, locked,
  // with the needed quantity carried as a hint. Staff fill Out / Back /
  // Quantity on what they assemble; off-list packs are manager-only (+ Add row).
  const channelPacks = packsByChannel[tab];
  const packById = new Map(channelPacks.map((p) => [p.id, p]));
  const tabLines = pickLines.filter((l) => packById.has(l.skuId));
  const initialRows = tabLines.map((l) => {
    const p = packById.get(l.skuId)!;
    return {
      __locked: "1",
      packSkuId: String(p.id),
      skuCode: p.code,
      packSize: `${p.packSizeText ?? ""}${p.packSizeText ? " · " : ""}need ${l.need}`,
      motherSkuId: p.motherSkuId ? String(p.motherSkuId) : "",
      qtyOut: "",
      qtyIn: "0",
      packsMade: "",
      qtyWaste: "",
      uom: tab === "BULK_FRUIT" ? "box" : "",
    };
  });

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg bg-neutral-100 p-1">
        {TABS.map((t) => {
          const count = pickLines.filter((l) =>
            packsByChannel[t.key].some((p) => p.id === l.skuId),
          ).length;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                tab === t.key ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500"
              }`}
            >
              {t.label}
              {count > 0 && (
                <span className="ml-1.5 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {tabLines.length === 0 && (
        <p className="mb-3 text-sm text-neutral-400">
          Nothing on today&apos;s pick list for this channel.
        </p>
      )}
      <EntryForm
        key={tab}
        kind="assembly"
        action={submitAssembly}
        channel={tab}
        motherSkus={motherSkus}
        packSkus={channelPacks}
        initialRows={initialRows.length ? initialRows : undefined}
        allowAddRow={allowAddRow}
        canPushToZoho={canPushToZoho}
        pushLabel={pushLabel}
        reasons={wasteReasons}
      />
    </div>
  );
}
