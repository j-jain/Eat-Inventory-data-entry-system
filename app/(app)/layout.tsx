import Image from "next/image";
import { redirect } from "next/navigation";
import { currentAccess } from "@/lib/auth/access";
import { Sidebar } from "@/components/Sidebar";
import { MobileNav } from "@/components/MobileNav";
import { InstallHint } from "@/components/InstallHint";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Live DB check every request: a blocked user (or stale JWT after a role
  // change) bounces straight to /login regardless of cookie validity.
  const access = await currentAccess();
  if (!access) redirect("/login");
  const user = access.session;
  const allowed = [...access.pages];
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* desktop sidebar (collapsible to an icon rail) */}
      <Sidebar allowed={allowed} />

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
      <MobileNav allowed={allowed} />
      <InstallHint />
    </div>
  );
}
