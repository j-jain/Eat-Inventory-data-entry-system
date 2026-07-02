"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type Option = { value: string; label: string; hint?: string; code?: string };

type PanelStyle = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

/**
 * Searchable select. The user can only ever submit a value from `options`
 * (no free typing) — typing only filters the list. This is the core
 * anti-error guarantee for SKU / vendor / customer / reason inputs.
 *
 * The options panel is rendered through a portal (position: fixed) so it is
 * never clipped by the surrounding `overflow-x-auto` table wrapper. It flips
 * above the trigger when there isn't room below and closes on outside-click,
 * page scroll, resize, or Escape.
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
  const [panel, setPanel] = useState<PanelStyle | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  const reposition = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const margin = 8;
    const minWidth = 288; // long SKU labels must fit (~ max-h-72 in px too)
    const width = Math.min(Math.max(r.width, minWidth), window.innerWidth - margin * 2);
    let left = r.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
    if (left < margin) left = margin;

    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const desired = 288;
    const flipUp = spaceBelow < desired && spaceAbove > spaceBelow;
    if (flipUp) {
      setPanel({
        left,
        width,
        bottom: window.innerHeight - r.top + 4,
        maxHeight: Math.min(spaceAbove - margin, desired),
      });
    } else {
      setPanel({
        left,
        width,
        top: r.bottom + 4,
        maxHeight: Math.min(spaceBelow - margin, desired),
      });
    }
  }, []);

  // position the panel synchronously before paint when it opens
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onScroll(e: Event) {
      // ignore scrolling inside the option list itself
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target))
        return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, reposition]);

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
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={btnRef}
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

      {open &&
        !disabled &&
        panel &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              left: panel.left,
              width: panel.width,
              maxHeight: panel.maxHeight,
              top: panel.top,
              bottom: panel.bottom,
              zIndex: 1000,
            }}
            className="overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg"
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
