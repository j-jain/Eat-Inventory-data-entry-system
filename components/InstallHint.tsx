"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * One-time "install as an app" nudge for floor phones/iPads. Chrome/Android:
 * uses the real install prompt. iOS Safari: shows the Add-to-Home-Screen tip
 * (no API exists). Never shows when already installed, and stays dismissed
 * once closed.
 */
export function InstallHint() {
  const [mode, setMode] = useState<"none" | "prompt" | "ios">("none");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (localStorage.getItem("eat-install-hint") === "dismissed") return;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari exposes navigator.standalone
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("prompt");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) setMode("ios");

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  function dismiss() {
    localStorage.setItem("eat-install-hint", "dismissed");
    setMode("none");
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    dismiss();
  }

  if (mode === "none") return null;
  return (
    <div className="fixed inset-x-3 bottom-20 z-40 flex items-center gap-3 rounded-xl border border-brand/50 bg-white p-3 shadow-lg md:left-auto md:right-6 md:bottom-6 md:w-96">
      <span className="text-2xl">📲</span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-ink">Use EAT Inventory as an app</p>
        <p className="text-xs text-neutral-500">
          {mode === "ios"
            ? "Tap Share → “Add to Home Screen” — it opens full-screen like a real app."
            : "Installs on this device — opens full-screen, no browser bar."}
        </p>
      </div>
      {mode === "prompt" && (
        <button
          type="button"
          onClick={install}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-ink hover:bg-brand-600"
        >
          Install
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="dismiss"
        className="rounded p-1 text-neutral-400 hover:text-neutral-600"
      >
        ✕
      </button>
    </div>
  );
}
