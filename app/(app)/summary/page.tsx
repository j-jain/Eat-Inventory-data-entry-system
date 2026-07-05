import { PageHeader, Card } from "@/components/PageHeader";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { dailySummary } from "@/lib/queries";
import { istToday } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const CHANNEL_LABEL: Record<string, string> = {
  BULK_FRUIT: "Bulk Fruit",
  BLINKIT: "Blinkit",
  SPENCERS: "Spencer's",
};

export default async function SummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { session } = await requirePageAccess("/summary");
  const { date: qDate } = await searchParams;
  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : istToday();
  const s = await dailySummary(date);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Summary Sheets"
          subtitle="Everything that happened across the workflow on one day — the digital version of the paper summary sheets."
        />
        <form className="flex items-center gap-2" action="/summary" method="get">
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm"
          />
          <button className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50">
            Show
          </button>
          {hasRole(session.role, "MANAGER") && (
            <a
              href={`/api/export/summary?date=${date}`}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
            >
              CSV ↓
            </a>
          )}
        </form>
      </div>

      {s.pickListExceptions.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            Pick list completed SHORT
          </h2>
          <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
            {s.pickListExceptions.map((e) => (
              <li key={e.id}>
                List #{e.id}: {e.reason}
                {e.completedBy ? ` — by ${e.completedBy}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Receiving" empty={s.receiving.length === 0}>
        <Table
          head={["SKU", "Item", "Vendor", "Accepted", "Remaining was", "Scenario"]}
          rows={s.receiving.map((r) => [
            mono(r.code),
            r.name,
            r.vendor ?? "—",
            num(r.accepted),
            r.expected != null ? num(r.expected) : "—",
            r.variance === "NONE" ? "—" : r.variance,
          ])}
        />
      </Section>

      <Section title="Sorting & Grading" empty={s.sorting.length === 0}>
        <Table
          head={["SKU", "Item", "Grade A", "Grade B", "Grade C", "Waste"]}
          rows={s.sorting.map((r) => [
            mono(r.code),
            r.name,
            num(r.a),
            num(r.b),
            num(r.c),
            num(r.waste, true),
          ])}
        />
      </Section>

      <Section title="DC Assembly (mother → pack conversion)" empty={s.assembly.length === 0}>
        <Table
          head={["Channel", "Pack", "Used (kg)", "Packs made", "kg / pack", "Waste"]}
          rows={s.assembly.map((r) => [
            CHANNEL_LABEL[r.channel] ?? r.channel,
            `${r.packCode} ${r.packName}`,
            num(r.used),
            num(r.packs),
            r.yieldPerPack != null ? num(r.yieldPerPack) : "—",
            num(r.waste, true),
          ])}
        />
      </Section>

      <Section title="Wastage by stage" empty={s.wastage.length === 0}>
        <Table
          head={["Stage", "SKU", "Item", "Qty", "Reason"]}
          rows={s.wastage.map((r) => [r.source, mono(r.code), r.name, num(r.qty, true), r.reason])}
        />
      </Section>

      <Section title="Dispatch & Delivery" empty={s.dispatch.length === 0}>
        <Table
          head={["Customer", "Channel", "SKU", "Item", "Dispatched", "Delivered", "Status"]}
          rows={s.dispatch.map((r) => [
            r.customer ?? "—",
            r.channel ? (CHANNEL_LABEL[r.channel] ?? r.channel) : "—",
            mono(r.code),
            r.name,
            num(r.qty),
            num(r.delivered),
            r.status,
          ])}
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-neutral-700">{title}</h2>
      {empty ? (
        <Card>
          <p className="text-sm text-neutral-400">Nothing recorded.</p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          {children}
        </div>
      )}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
        <tr>
          {head.map((h) => (
            <th key={h} className="px-4 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-neutral-50">
            {r.map((c, j) => (
              <td key={j} className="px-4 py-1.5 text-neutral-700">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const mono = (t: string) => <span className="font-mono text-xs text-neutral-600">{t}</span>;
const num = (t: string, red = false) => (
  <span className={`font-mono ${red && Number(t) > 0 ? "text-red-600" : ""}`}>{t}</span>
);
