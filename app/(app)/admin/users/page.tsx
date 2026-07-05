import { PageHeader } from "@/components/PageHeader";
import { UsersAdmin } from "@/components/UsersAdmin";
import { requireAdmin } from "@/lib/auth/rbac";
import { listUsersAdmin } from "@/actions/users";
import { PAGE_DEFS } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

export default async function UsersAdminPage() {
  const s = await requireAdmin();
  const rows = await listUsersAdmin();
  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Onboard, block, set PINs (visible to admins only) and choose exactly which pages each person sees. Changes apply immediately."
      />
      <UsersAdmin rows={rows} pageDefs={PAGE_DEFS} currentUserId={s.uid} />
    </div>
  );
}
