"use client";

import { useEffect, useRef, useState } from "react";

/**
 * PWA-safe replacement for window.prompt(): a bottom-sheet on phones, a
 * centered dialog on desktop. Used everywhere a supervisor reason is
 * required (short-complete, cancel, void).
 */
export function ReasonDialog({
  title,
  description,
  placeholder = "Reason…",
  confirmLabel = "Confirm",
  tone = "amber",
  minLength = 3,
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: string;
  placeholder?: string;
  confirmLabel?: string;
  tone?: "amber" | "red";
  minLength?: number;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const valid = reason.trim().length >= minLength;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/40 md:items-center"
      onClick={onCancel}
    >
      <div
        className="w-full rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:max-w-md md:rounded-2xl md:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200 md:hidden" />
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        {description && <p className="mt-1 text-sm text-neutral-500">{description}</p>}
        <textarea
          ref={inputRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-brand-600 md:text-sm"
        />
        {!valid && reason.length > 0 && (
          <p className="mt-1 text-xs text-red-600">At least {minLength} characters.</p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 md:py-2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => onConfirm(reason.trim())}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 md:py-2 ${
              tone === "red" ? "bg-red-600 hover:bg-red-700" : "bg-amber-600 hover:bg-amber-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
