"use client";

import { cn } from "@/lib/utils";

/**
 * Segmented-control tab bar (the AssemblyTabs pattern, extracted). Purely
 * controlled — parent owns the active key. `badge` renders a small count
 * chip; `tone` colors it (e.g. amber for needs-attention counts).
 */
export type TabDef<K extends string> = {
  key: K;
  label: string;
  badge?: number;
  tone?: "neutral" | "amber" | "red" | "brand";
};

const BADGE_TONE: Record<NonNullable<TabDef<string>["tone"]>, string> = {
  neutral: "bg-neutral-200 text-neutral-600",
  amber: "bg-amber-200 text-amber-800",
  red: "bg-red-200 text-red-800",
  brand: "bg-brand/40 text-ink",
};

export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabDef<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto rounded-lg bg-neutral-100 p-1",
        className,
      )}
      role="tablist"
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "flex-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
            active === t.key
              ? "bg-white text-neutral-900 shadow-sm"
              : "text-neutral-500 hover:text-neutral-700",
          )}
        >
          {t.label}
          {t.badge != null && t.badge > 0 && (
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                BADGE_TONE[t.tone ?? "neutral"],
              )}
            >
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
