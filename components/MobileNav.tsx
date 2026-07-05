"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_LINKS, navVisiblePages } from "@/components/nav-links";

/** Bottom tab bar (phones): the 4 everyday stations + a More sheet. */
const TABS: { href: string; label: string; icon: string }[] = [
  { href: "/dashboard", label: "Stock", icon: "📊" },
  { href: "/receiving", label: "Receive", icon: "📥" },
  { href: "/pick-list", label: "Pick", icon: "📋" },
  { href: "/assembly", label: "Pack", icon: "📦" },
];

export function MobileNav({ allowed }: { allowed: string[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const links = NAV_LINKS.filter((l) => navVisiblePages(l, allowed));
  const tabs = TABS.filter((t) => allowed.includes(t.href));

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 md:hidden"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute inset-x-0 bottom-16 max-h-[70vh] overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
            {["Entry", "Reference", "Manager", "Admin"].map((g) => {
              const group = links.filter((l) => l.group === g);
              if (!group.length) return null;
              return (
                <div key={g} className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {g}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {group.map((l) => (
                      <Link
                        key={l.href}
                        href={l.href}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "rounded-lg px-3 py-2.5 text-sm",
                          path.startsWith(l.href)
                            ? "bg-brand font-medium text-ink"
                            : "bg-neutral-50 text-neutral-700",
                        )}
                      >
                        {l.label}
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-50 flex h-16 items-stretch border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {tabs.map((t) => {
          const active = path === t.href || path.startsWith(t.href + "/");
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                active ? "text-brand-800" : "text-neutral-400",
              )}
            >
              <span
                className={cn(
                  "rounded-full px-3 py-0.5 text-base leading-6",
                  active && "bg-brand/30",
                )}
              >
                {t.icon}
              </span>
              {t.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
            open ? "text-brand-800" : "text-neutral-400",
          )}
        >
          <span className={cn("rounded-full px-3 py-0.5 text-base leading-6", open && "bg-brand/30")}>
            ☰
          </span>
          More
        </button>
      </nav>
    </>
  );
}
