"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { cn } from "@/lib/utils";

/**
 * Desktop sidebar with an app-like collapse: full menu ↔ icon rail. The
 * choice is remembered per device (localStorage) — floor desktops can keep
 * it collapsed for full-width sheets.
 */
export function Sidebar({ allowed }: { allowed: string[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem("eat-sidebar") === "collapsed");
    setReady(true);
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("eat-sidebar", next ? "collapsed" : "open");
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "hidden shrink-0 border-r border-neutral-200 bg-white transition-[width] duration-200 md:block",
        collapsed ? "w-16 p-2" : "w-60 p-4",
      )}
    >
      <div className={cn("mb-4 flex items-center", collapsed ? "flex-col gap-2" : "gap-2.5 px-3")}>
        <Image
          src="/eat-logo.png"
          alt="EAT"
          width={collapsed ? 32 : 36}
          height={collapsed ? 32 : 36}
          className="rounded-full"
          priority
        />
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-ink">EAT Inventory</div>
            <div className="text-[11px] text-neutral-400">storage-room live entry</div>
          </div>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600",
            collapsed ? "" : "ml-auto",
          )}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      {/* render nothing until the stored preference is known — avoids a flash */}
      {ready && <Nav allowed={allowed} collapsed={collapsed} />}
    </aside>
  );
}
