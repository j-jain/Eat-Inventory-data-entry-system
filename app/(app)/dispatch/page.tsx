import { PageHeader, Card } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default function DispatchPage() {
  return (
    <div>
      <PageHeader
        title="Dispatch"
        subtitle="Ship finished packs out of finished-goods stock."
      />
      <Card>
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium uppercase tracking-wide text-amber-700">
            Coming soon
          </span>
          <p className="max-w-md text-sm text-neutral-500">
            Dispatch isn&apos;t available yet. It will let you ship finished packs out
            of finished-goods stock once the flow is finalised.
          </p>
        </div>
      </Card>
    </div>
  );
}
