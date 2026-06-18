import { listLoginUsers } from "@/actions/auth";
import { PinLogin } from "@/components/PinLogin";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const users = await listLoginUsers();
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-neutral-900">EAT Inventory</h1>
          <p className="mt-1 text-sm text-neutral-500">Pick your name and enter your PIN</p>
        </div>
        <PinLogin users={users} />
      </div>
    </div>
  );
}
