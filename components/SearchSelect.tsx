"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type Option = { value: string; label: string; hint?: string; code?: string };

/**
 * Searchable select. The user can only ever submit a value from `options`
 * (no free typing) — typing only filters the list. This is the core
 * anti-error guarantee for SKU / vendor / customer / reason inputs.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Search…",
  className,
  disabled,
}: {
  options: Option[];
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.code?.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q) ||
          o.hint?.toLowerCase().includes(q),
      )
    : options;

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-left text-sm",
          "focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-neutral-100 disabled:text-neutral-400",
        )}
      >
        <span className={cn("truncate", !selected && "text-neutral-400")}>
          {selected
            ? selected.code
              ? `${selected.code} · ${selected.label}`
              : selected.label
            : placeholder}
        </span>
        <span className="text-neutral-400">▾</span>
      </button>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg">
          <div className="sticky top-0 bg-white p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              className="w-full rounded border border-neutral-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          {selected && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
                setQuery("");
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-500 hover:bg-neutral-50"
            >
              ✕ clear
            </button>
          )}
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-sm text-neutral-400">No matches</div>
          )}
          {filtered.slice(0, 200).map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
                setQuery("");
              }}
              className={cn(
                "block w-full px-3 py-1.5 text-left text-sm hover:bg-emerald-50",
                o.value === value && "bg-emerald-50 font-medium",
              )}
            >
              {o.code && (
                <span className="font-mono text-xs text-neutral-500">{o.code}</span>
              )}{" "}
              {o.label}
              {o.hint && <span className="ml-1 text-xs text-neutral-400">· {o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
