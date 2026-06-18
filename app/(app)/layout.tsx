import { requireUser } from "@/lib/auth/rbac";
import { Nav } from "@/components/Nav";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-neutral-200 bg-white p-4">
        <div className="mb-6 px-3">
          <div className="text-lg font-semibold text-neutral-900">EAT Inventory</div>
          <div className="text-xs text-neutral-400">storage-room live entry</div>
        </div>
        <Nav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
          <div className="text-sm text-neutral-500">
            Signed in as <span className="font-medium text-neutral-800">{user.name}</span>{" "}
            <span className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
              {user.role}
            </span>
          </div>
          <SignOutButton />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
