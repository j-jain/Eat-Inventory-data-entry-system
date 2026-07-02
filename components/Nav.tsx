"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type NavLink = { href: string; label: string; group: string; disabled?: boolean };

const LINKS: NavLink[] = [
  { href: "/dashboard", label: "Live Inventory", group: "" },
  { href: "/receiving", label: "Receiving", group: "Entry" },
  { href: "/sorting", label: "Sorting / Grading", group: "Entry" },
  { href: "/regrade", label: "Regrade", group: "Entry" },
  { href: "/assembly", label: "DC Assembly", group: "Entry" },
  { href: "/dispatch", label: "Dispatch", group: "Entry", disabled: true },
  { href: "/return", label: "Returns", group: "Entry" },
  { href: "/wastage", label: "Wastage", group: "Entry" },
  { href: "/adjustment", label: "Inventory Adjustment", group: "Entry" },
  { href: "/purchase-orders", label: "Purchase Orders", group: "Reference" },
  { href: "/admin/skus", label: "SKUs", group: "Admin" },
  { href: "/admin/sync", label: "Zoho Sync", group: "Admin" },
];

export function Nav() {
  const path = usePathname();
  const groups = ["", "Entry", "Reference", "Admin"];
  return (
    <nav className="space-y-4 text-sm">
      {groups.map((g) => (
        <div key={g}>
          {g && (
            <div className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {g}
            </div>
          )}
          <ul className="space-y-0.5">
            {LINKS.filter((l) => l.group === g).map((l) => {
              const active = path === l.href || path.startsWith(l.href + "/");
              if (l.disabled) {
                return (
                  <li key={l.href}>
                    <span
                      aria-disabled="true"
                      title="Coming soon"
                      className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-1.5 text-neutral-400"
                    >
                      {l.label}
                      <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                        soon
                      </span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className={cn(
                      "block rounded-md px-3 py-1.5",
                      active
                        ? "bg-emerald-600 font-medium text-white"
                        : "text-neutral-600 hover:bg-neutral-100",
                    )}
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
