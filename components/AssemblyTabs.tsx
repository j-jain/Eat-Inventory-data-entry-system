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
  prelistByChannel,
}: {
  motherSkus: SkuOpt[];
  packsByChannel: Record<Channel, SkuOpt[]>;
  /** Curated (Excel-sheet) packs to pre-list per channel; falls back to all. */
  prelistByChannel?: Record<Channel, SkuOpt[]>;
}) {
  const [tab, setTab] = useState<Channel>("BLINKIT");
  // Pre-list the operational (Excel-sheet) packs for the active channel as locked
  // rows (SKU + pack size + mother shown read-only); staff only fill Out / Back /
  // Quantity on what they made. The full channel list still feeds + Add row.
  const prelist = prelistByChannel?.[tab] ?? packsByChannel[tab];
  const initialRows = prelist.map((p) => ({
    __locked: "1",
    packSkuId: String(p.id),
    skuCode: p.code,
    packSize: p.packSizeText ?? "",
    motherSkuId: p.motherSkuId ? String(p.motherSkuId) : "",
    qtyOut: "",
    qtyIn: "0",
    packsMade: "",
    // Bulk Fruit has no fixed pack size — packer picks a unit (default Box).
    uom: tab === "BULK_FRUIT" ? "box" : "",
  }));
  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg bg-neutral-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
              tab === t.key ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <EntryForm
        key={tab}
        kind="assembly"
        action={submitAssembly}
        channel={tab}
        motherSkus={motherSkus}
        packSkus={packsByChannel[tab]}
        initialRows={initialRows}
      />
    </div>
  );
}
