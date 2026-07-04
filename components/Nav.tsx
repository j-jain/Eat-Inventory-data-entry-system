"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_LINKS, navVisible, type NavRole } from "@/components/nav-links";

/** Desktop sidebar navigation (phones use the MobileNav bottom bar). */
export function Nav({ role }: { role: NavRole }) {
  const path = usePathname();
  const links = NAV_LINKS.filter((l) => navVisible(l, role));
  const groups = ["", "Entry", "Reference", "Manager", "Admin"] as const;
  return (
    <nav className="space-y-4 text-sm">
      {groups.map((g) => {
        const group = links.filter((l) => l.group === g);
        if (!group.length) return null;
        return (
          <div key={g}>
            {g && (
              <div className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {g}
              </div>
            )}
            <ul className="space-y-0.5">
              {group.map((l) => {
                const active = path === l.href || path.startsWith(l.href + "/");
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className={cn(
                        "block rounded-md px-3 py-1.5",
                        active
                          ? "bg-brand font-medium text-ink"
                          : "text-neutral-600 hover:bg-cream",
                      )}
                    >
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
