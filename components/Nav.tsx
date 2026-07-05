"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_LINKS, navVisiblePages } from "@/components/nav-links";

const GROUPS = ["", "Entry", "Reference", "Manager", "Admin"] as const;

/** Desktop sidebar navigation (phones use the MobileNav bottom bar).
 *  v3: filtered by the user's effective page set; groups collapse (remembered
 *  per device) so the Admin block doesn't dominate; `collapsed` renders the
 *  icon rail. */
export function Nav({ allowed, collapsed = false }: { allowed: string[]; collapsed?: boolean }) {
  const path = usePathname();
  const links = NAV_LINKS.filter((l) => navVisiblePages(l, allowed));
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("eat-nav-groups") ?? "[]");
      if (Array.isArray(stored)) setClosedGroups(new Set(stored));
    } catch {
      /* ignore */
    }
  }, []);

  function toggleGroup(g: string) {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      localStorage.setItem("eat-nav-groups", JSON.stringify([...next]));
      return next;
    });
  }

  if (collapsed) {
    return (
      <nav className="flex flex-col items-center gap-1">
        {links.map((l) => {
          const active = path === l.href || path.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              title={l.label}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg text-lg",
                active ? "bg-brand" : "hover:bg-cream",
              )}
            >
              {l.icon}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="space-y-3 text-sm">
      {GROUPS.map((g) => {
        const group = links.filter((l) => l.group === g);
        if (!group.length) return null;
        const closed = g !== "" && closedGroups.has(g);
        const hasActive = group.some((l) => path === l.href || path.startsWith(l.href + "/"));
        return (
          <div key={g}>
            {g && (
              <button
                type="button"
                onClick={() => toggleGroup(g)}
                className="mb-1 flex w-full items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-600"
              >
                {g}
                <span className="text-[10px]">{closed ? "▸" : "▾"}</span>
              </button>
            )}
            {(!closed || hasActive) && (
              <ul className="space-y-0.5">
                {group.map((l) => {
                  const active = path === l.href || path.startsWith(l.href + "/");
                  if (closed && !active) return null;
                  return (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-3 py-1.5",
                          active
                            ? "bg-brand font-medium text-ink"
                            : "text-neutral-600 hover:bg-cream",
                        )}
                      >
                        <span className="text-sm">{l.icon}</span>
                        {l.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
