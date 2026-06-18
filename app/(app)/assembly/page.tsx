import { PageHeader, Card } from "@/components/PageHeader";
import { AssemblyTabs } from "@/components/AssemblyTabs";
import { motherSkus, packSkusByChannel } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AssemblyPage() {
  const [mothers, bz, s, bf] = await Promise.all([
    motherSkus(),
    packSkusByChannel("BLINKIT"),
    packSkusByChannel("SPENCERS"),
    packSkusByChannel("BULK_FRUIT"),
  ]);
  return (
    <div>
      <PageHeader
        title="DC Assembly"
        subtitle="Draw mother stock out of cold room, make packs. Used = Out − In (kg). Packs×size is an advisory check only."
      />
      <Card>
        <AssemblyTabs
          motherSkus={mothers}
          packsByChannel={{ BLINKIT: bz, SPENCERS: s, BULK_FRUIT: bf }}
        />
      </Card>
    </div>
  );
}
