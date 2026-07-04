import Image from "next/image";
import { requireUser } from "@/lib/auth/rbac";
import { Nav } from "@/components/Nav";
import { MobileNav } from "@/components/MobileNav";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-neutral-200 bg-white p-4 md:block">
        <div className="mb-6 flex items-center gap-2.5 px-3">
          <Image
            src="/eat-logo.png"
            alt="EAT"
            width={36}
            height={36}
            className="rounded-full"
            priority
          />
          <div>
            <div className="text-base font-semibold text-ink">EAT Inventory</div>
            <div className="text-[11px] text-neutral-400">storage-room live entry</div>
          </div>
        </div>
        <Nav role={user.role} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-neutral-200 bg-white/95 px-4 py-2.5 backdrop-blur md:px-6 md:py-3">
          <div className="flex items-center gap-2">
            <Image
              src="/eat-logo.png"
              alt="EAT"
              width={28}
              height={28}
              className="rounded-full md:hidden"
              priority
            />
            <div className="text-sm text-neutral-500">
              <span className="font-medium text-ink">{user.name}</span>{" "}
              <span className="ml-1 rounded bg-brand/20 px-1.5 py-0.5 text-xs font-medium text-brand-800">
                {user.role}
              </span>
            </div>
          </div>
          <SignOutButton />
        </header>
        <main className="flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>
      </div>

      {/* phone bottom tabs */}
      <MobileNav role={user.role} />
    </div>
  );
}
