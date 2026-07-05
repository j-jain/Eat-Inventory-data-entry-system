"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  previewPush,
  pushToZoho,
  reconcileDoc,
  reconcilePush,
  type PushPreview,
} from "@/actions/zoho-drafts";
import { closePoRemainder, updateZohoPo } from "@/actions/po";
import type { PushHistoryRow, ReviewRow, ReviewStatus } from "@/lib/zoho/review";
import type { PoWorkspaceCard, PushGlance } from "@/lib/zoho/po-workspace";
import type { CombinedStockRow } from "@/lib/ledger/balance";
import { Tabs, type TabDef } from "@/components/Tabs";
import { D } from "@/lib/money";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- chrome */

const CHIP: Record<ReviewStatus, string> = {
  PENDING: "bg-neutral-100 text-neutral-600",
  PUSHED: "bg-brand/25 text-brand-800",
  PARTIAL: "bg-amber-100 text-amber-700",
  FAILED: "bg-red-100 text-red-700",
  UNKNOWN: "bg-purple-100 text-purple-700",
};

function StatusChip({
  status,
  progress,
}: {
  status: ReviewStatus | PushGlance["status"];
  progress?: { pushed: number; total: number };
}) {
  const s = status === "IN_FLIGHT" ? "UNKNOWN" : (status as ReviewStatus);
  const label =
    status === "PUSHED" || status === "SUCCESS"
      ? "PUSHED ✓"
      : status === "IN_FLIGHT"
        ? "IN FLIGHT…"
        : status === "UNKNOWN"
          ? "NEEDS CHECK"
          : s === "PARTIAL" && progress
            ? `PARTIAL ${progress.pushed}/${progress.total}`
            : status;
  const cls = status === "SUCCESS" ? CHIP.PUSHED : CHIP[s] ?? CHIP.PENDING;
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export type ZohoUiBases = { inventory: string | null; books: string | null };

function zohoRecordUrl(kind: string, zohoId: string | null, ui: ZohoUiBases): string | null {
  if (!zohoId) return null;
  switch (kind) {
    case "receiving.bill":
      return ui.books ? `${ui.books}/bills/${zohoId}` : null;
    case "podraft.create":
      return ui.inventory ? `${ui.inventory}/purchaseorders/${zohoId}` : null;
    case "wastage.adj":
    case "adjustment.adj":
      return ui.inventory ? `${ui.inventory}/inventoryadjustments/${zohoId}` : null;
    case "receiving.receive":
      return ui.inventory ? `${ui.inventory}/purchasereceives/${zohoId}` : null;
    case "assembly.bundle":
      return ui.inventory ? `${ui.inventory}/bundles/${zohoId}` : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------ main shell */

type TabKey = "pos" | "inventory" | "books" | "stock" | "history";

export function ReviewClient({
  rows,
  stock,
  pos,
  history,
  zohoUi,
}: {
  rows: ReviewRow[];
  stock: CombinedStockRow[];
  pos: PoWorkspaceCard[];
  history: PushHistoryRow[];
  zohoUi: ZohoUiBases;
}) {
  const [tab, setTab] = useState<TabKey>("pos");
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const invRows = useMemo(
    () =>
      rows.filter((r) =>
        ["wastage.adj", "adjustment.adj", "assembly.bundle", "podraft.create"].includes(r.kind),
      ),
    [rows],
  );
  const bookRows = useMemo(() => rows.filter((r) => r.kind === "receiving.bill"), [rows]);

  const attention = (list: ReviewRow[]) =>
    list.filter((r) => r.status !== "PUSHED").length;
  const poAttention = pos.filter(
    (c) =>
      c.receivings.some(
        (r) => r.receive.status !== "SUCCESS" || r.bill.status !== "SUCCESS",
      ) || D(c.totals.remaining).gt(0),
  ).length;

  const tabs: TabDef<TabKey>[] = [
    { key: "pos", label: "Purchase Orders", badge: poAttention, tone: "amber" },
    { key: "inventory", label: "Inventory pushes", badge: attention(invRows), tone: "amber" },
    { key: "books", label: "Books pushes", badge: attention(bookRows), tone: "amber" },
    { key: "stock", label: "Combined stock" },
    { key: "history", label: "History" },
  ];

  /** run a server action, surface its message, refresh server data */
  function run(key: string, fn: () => Promise<{ ok: boolean; error?: string } | void>, okMsg?: string) {
    setBusyKey(key);
    setFlash(null);
    start(async () => {
      try {
        const res = await fn();
        if (res && "ok" in res && !res.ok) {
          setFlash({ type: "err", text: res.error ?? "Something went wrong." });
        } else if (okMsg) {
          setFlash({ type: "ok", text: okMsg });
        }
      } catch (e) {
        setFlash({ type: "err", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusyKey(null);
        router.refresh();
      }
    });
  }

  async function pushRow(r: ReviewRow) {
    const res = await pushToZoho(r.kind, r.docId);
    if (!res.ok) return res;
    const bad = res.results.filter((x) => !x.ok);
    if (bad.length)
      return { ok: false, error: bad[0].error ?? "Push failed." };
    return { ok: true };
  }

  async function pushAllIn(list: ReviewRow[]) {
    // sequential, continue past failures — order preserved
    let failures = 0;
    for (const r of list) {
      if (r.status === "PUSHED" || r.status === "UNKNOWN") continue;
      const res = await pushRow(r);
      if (!res.ok) failures++;
    }
    return failures
      ? { ok: false as const, error: `${failures} push(es) failed — see the cards below.` }
      : { ok: true as const };
  }

  return (
    <div className="space-y-4">
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {flash && (
        <p
          className={cn(
            "rounded-md px-3 py-2 text-sm",
            flash.type === "ok" ? "bg-brand/15 text-brand-800" : "bg-red-50 text-red-700",
          )}
        >
          {flash.text}
        </p>
      )}

      {tab === "pos" && (
        <PoTab
          pos={pos}
          zohoUi={zohoUi}
          busyKey={busyKey}
          pending={pending}
          run={run}
        />
      )}
      {tab === "inventory" && (
        <QueueTab
          list={invRows}
          zohoUi={zohoUi}
          busyKey={busyKey}
          pending={pending}
          run={run}
          onPush={pushRow}
          onPushAll={() => pushAllIn(invRows)}
          emptyText="No inventory-side documents in the last 30 days."
        />
      )}
      {tab === "books" && (
        <QueueTab
          list={bookRows}
          zohoUi={zohoUi}
          busyKey={busyKey}
          pending={pending}
          run={run}
          onPush={pushRow}
          onPushAll={() => pushAllIn(bookRows)}
          emptyText="No bills to push in the last 30 days."
        />
      )}
      {tab === "stock" && <CombinedStock stock={stock} />}
      {tab === "history" && <HistoryTab history={history} zohoUi={zohoUi} />}
    </div>
  );
}

type RunFn = (
  key: string,
  fn: () => Promise<{ ok: boolean; error?: string } | void>,
  okMsg?: string,
) => void;

/* ------------------------------------------------------- queue tab cards */

function QueueTab({
  list,
  zohoUi,
  busyKey,
  pending,
  run,
  onPush,
  onPushAll,
  emptyText,
}: {
  list: ReviewRow[];
  zohoUi: ZohoUiBases;
  busyKey: string | null;
  pending: boolean;
  run: RunFn;
  onPush: (r: ReviewRow) => Promise<{ ok: boolean; error?: string }>;
  onPushAll: () => Promise<{ ok: boolean; error?: string }>;
  emptyText: string;
}) {
  const pushable = list.filter((r) => r.status !== "PUSHED" && r.status !== "UNKNOWN").length;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400">
          Every card shows exactly what will be created in Zoho — open “What will be sent”.
        </p>
        <button
          type="button"
          onClick={() => run("push-all", onPushAll, "All pending pushes attempted.")}
          disabled={pending || pushable === 0}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50"
        >
          {busyKey === "push-all" ? "Pushing…" : `Push all pending (${pushable})`}
        </button>
      </div>
      {list.length === 0 && <p className="text-sm text-neutral-400">{emptyText}</p>}
      {list.map((r) => (
        <RowCard
          key={`${r.kind}-${r.docId}`}
          r={r}
          zohoUi={zohoUi}
          busy={pending}
          busyKey={busyKey}
          run={run}
          onPush={onPush}
        />
      ))}
    </div>
  );
}

function RowCard({
  r,
  zohoUi,
  busy,
  busyKey,
  run,
  onPush,
}: {
  r: ReviewRow;
  zohoUi: ZohoUiBases;
  busy: boolean;
  busyKey: string | null;
  run: RunFn;
  onPush: (r: ReviewRow) => Promise<{ ok: boolean; error?: string }>;
}) {
  const key = `${r.kind}-${r.docId}`;
  const link = zohoRecordUrl(r.kind, r.zohoId, zohoUi);
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip status={r.status} progress={r.progress} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-neutral-800">{r.summary}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-400">{r.businessDate}</span>
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
              {r.landsIn}
            </span>
            {r.zohoNumber && (
              <span className="rounded bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand-800">
                {r.zohoNumber}
              </span>
            )}
            {link && (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-sky-600 hover:underline"
              >
                open in Zoho ↗
              </a>
            )}
          </div>
        </div>
        {r.status === "UNKNOWN" ? (
          <button
            type="button"
            onClick={() =>
              run(`rec-${key}`, async () => {
                const res = await reconcileDoc(r.kind, r.docId);
                return res.ok ? { ok: true } : { ok: false, error: res.error };
              }, "Reconciled against Zoho.")
            }
            disabled={busy}
            className="rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-sm text-purple-700 hover:bg-purple-100 disabled:opacity-50"
            title="Checks Zoho for the stamped reference before anything is re-sent — prevents duplicates"
          >
            {busyKey === `rec-${key}` ? "Checking…" : "Reconcile"}
          </button>
        ) : r.status !== "PUSHED" ? (
          <button
            type="button"
            onClick={() => run(`push-${key}`, () => onPush(r), "Pushed to Zoho.")}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {busyKey === `push-${key}` ? "Pushing…" : r.status === "PENDING" ? "Push" : "Retry"}
          </button>
        ) : null}
      </div>
      {r.error && r.status !== "PUSHED" && <ErrorFold error={r.error} />}
      {r.status !== "PUSHED" && <PreviewFold kind={r.kind} docId={r.docId} />}
    </div>
  );
}

function ErrorFold({ error }: { error: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-red-600 hover:underline"
      >
        {open ? "Hide error" : "Show error"}
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
          {error}
        </pre>
      )}
    </div>
  );
}

function PreviewFold({
  kind,
  docId,
}: {
  kind: ReviewRow["kind"];
  docId: number;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !preview) {
      setLoading(true);
      try {
        setPreview(await previewPush(kind, docId));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="mt-2">
      <button type="button" onClick={toggle} className="text-xs text-sky-600 hover:underline">
        {open ? "Hide payload" : "What will be sent →"}
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          {loading && <p className="text-xs text-neutral-400">Building payload…</p>}
          {preview && !preview.ok && (
            <p className="rounded bg-amber-50 p-2 text-xs text-amber-700">{preview.error}</p>
          )}
          {preview?.ok &&
            preview.requests.map((req) => (
              <div key={req.subKey} className="rounded bg-neutral-50 p-2">
                <p className="mb-1 font-mono text-[11px] text-neutral-500">
                  {req.method} {req.url}
                </p>
                <pre className="overflow-x-auto text-xs text-neutral-700">
                  {JSON.stringify(req.body, null, 2)}
                </pre>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ PO tab */

function PoTab({
  pos,
  zohoUi,
  busyKey,
  pending,
  run,
}: {
  pos: PoWorkspaceCard[];
  zohoUi: ZohoUiBases;
  busyKey: string | null;
  pending: boolean;
  run: RunFn;
}) {
  if (!pos.length)
    return <p className="text-sm text-neutral-400">No purchase orders with activity.</p>;
  return (
    <div className="space-y-3">
      {pos.map((c) => (
        <PoCard key={c.zohoPoId} c={c} zohoUi={zohoUi} busyKey={busyKey} pending={pending} run={run} />
      ))}
    </div>
  );
}

function PoCard({
  c,
  zohoUi,
  busyKey,
  pending,
  run,
}: {
  c: PoWorkspaceCard;
  zohoUi: ZohoUiBases;
  busyKey: string | null;
  pending: boolean;
  run: RunFn;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const remaining = D(c.totals.remaining);
  const poLink = zohoUi.inventory ? `${zohoUi.inventory}/purchaseorders/${c.zohoPoId}` : null;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-100 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-neutral-800">
              {c.poNumber ?? c.zohoPoId}
            </span>
            <span className="text-sm text-neutral-600">{c.vendorName ?? "—"}</span>
            {c.poDate && <span className="text-xs text-neutral-400">{c.poDate}</span>}
            {c.zohoStatus && (
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
                {c.zohoStatus}
              </span>
            )}
            {poLink && (
              <a href={poLink} target="_blank" rel="noreferrer" className="text-[11px] text-sky-600 hover:underline">
                open in Zoho ↗
              </a>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-neutral-500">
            <span>Ordered <b className="font-mono">{c.totals.ordered}</b></span>
            <span>Received <b className="font-mono text-brand-800">{c.totals.received}</b></span>
            <span>
              Remaining{" "}
              <b className={cn("font-mono", remaining.gt(0) ? "text-amber-600" : "text-neutral-400")}>
                {c.totals.remaining}
              </b>
            </span>
          </div>
        </div>
        {c.inCache && c.lines.length > 0 && (
          <button
            type="button"
            onClick={() => setEditOpen((v) => !v)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            {editOpen ? "Close editor" : "Edit quantities"}
          </button>
        )}
        {c.canCloseRemainder && (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Trim PO ${c.poNumber ?? c.zohoPoId} down to the received quantities (${c.totals.received})? Zoho will treat it as fully received and close it. Lines never received are REMOVED. Place a fresh PO for the cancelled part separately.`,
                )
              )
                run(`close-${c.zohoPoId}`, () => closePoRemainder(c.zohoPoId), "PO trimmed to received quantities in Zoho.");
            }}
            disabled={pending}
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            title="Receive what came, cancel the rest — Zoho closes the PO"
          >
            {busyKey === `close-${c.zohoPoId}` ? "Closing…" : "Close remainder…"}
          </button>
        )}
      </div>

      {/* lines */}
      {c.lines.length > 0 && (
        <div className="overflow-x-auto px-3 pt-2">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="py-1 pr-3 font-medium">Item</th>
                <th className="py-1 pr-3 text-right font-medium">Ordered</th>
                <th className="py-1 pr-3 text-right font-medium">Received</th>
                <th className="py-1 pr-3 text-right font-medium">Remaining</th>
                <th className="py-1 pr-3 text-right font-medium">Rate ₹</th>
                <th className="py-1 text-right font-medium">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.lineItemId} className="border-t border-neutral-50">
                  <td className="py-1 pr-3">
                    <span className="font-mono text-xs text-neutral-600">{l.code ?? l.skuText}</span>{" "}
                    <span className="text-neutral-700">{l.name}</span>
                  </td>
                  <td className="py-1 pr-3 text-right font-mono">{l.orderedQty}</td>
                  <td className="py-1 pr-3 text-right font-mono text-brand-800">{l.receivedQty}</td>
                  <td
                    className={cn(
                      "py-1 pr-3 text-right font-mono",
                      D(l.remainingQty).gt(0) ? "text-amber-600" : "text-neutral-400",
                    )}
                  >
                    {l.remainingQty}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono text-neutral-500">{l.rate ?? "—"}</td>
                  <td className="py-1 text-right font-mono text-neutral-500">{l.amount ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editOpen && (
        <InlinePoEditor
          zohoPoId={c.zohoPoId}
          lines={c.lines}
          pending={pending}
          busyKey={busyKey}
          run={run}
          onDone={() => setEditOpen(false)}
        />
      )}

      {/* receipts + their pushes */}
      <div className="space-y-2 p-3">
        {c.receivings.length === 0 && (
          <p className="text-xs text-neutral-400">No receipts recorded yet.</p>
        )}
        {c.receivings.map((rcv) => (
          <ReceiptRow key={rcv.docId} rcv={rcv} zohoUi={zohoUi} pending={pending} busyKey={busyKey} run={run} />
        ))}
      </div>
      {c.closeBlockReason && remaining.gt(0) && c.inCache && (
        <p className="border-t border-neutral-100 px-3 py-2 text-xs text-neutral-400">
          Close remainder unavailable: {c.closeBlockReason}
        </p>
      )}
    </div>
  );
}

function ReceiptRow({
  rcv,
  zohoUi,
  pending,
  busyKey,
  run,
}: {
  rcv: PoWorkspaceCard["receivings"][number];
  zohoUi: ZohoUiBases;
  pending: boolean;
  busyKey: string | null;
  run: RunFn;
}) {
  const lineText = rcv.lines.map((l) => `${l.code} ${l.qty}`).join(" · ");
  return (
    <div className="rounded-lg bg-neutral-50 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-neutral-700">Receipt #{rcv.docId}</span>
        <span className="text-xs text-neutral-400">{rcv.businessDate}</span>
        {rcv.variance !== "NONE" && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
            {rcv.variance}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500">{lineText}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <PushSlot
          label="Receive → Zoho Inventory"
          kind="receiving.receive"
          docId={rcv.docId}
          glance={rcv.receive}
          zohoUi={zohoUi}
          pending={pending}
          busyKey={busyKey}
          run={run}
        />
        <PushSlot
          label="Bill → Zoho Books"
          kind="receiving.bill"
          docId={rcv.docId}
          glance={rcv.bill}
          zohoUi={zohoUi}
          pending={pending}
          busyKey={busyKey}
          run={run}
        />
      </div>
      {(rcv.receive.error || rcv.bill.error) && (
        <ErrorFold error={[rcv.receive.error, rcv.bill.error].filter(Boolean).join("\n\n")} />
      )}
    </div>
  );
}

function PushSlot({
  label,
  kind,
  docId,
  glance,
  zohoUi,
  pending,
  busyKey,
  run,
}: {
  label: string;
  kind: "receiving.receive" | "receiving.bill";
  docId: number;
  glance: PushGlance;
  zohoUi: ZohoUiBases;
  pending: boolean;
  busyKey: string | null;
  run: RunFn;
}) {
  const key = `${kind}-${docId}`;
  const link = zohoRecordUrl(kind, glance.zohoId, zohoUi);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-500">{label}</span>
      <StatusChip status={glance.status} />
      {glance.zohoNumber && (
        <span className="font-mono text-[11px] text-brand-800">{glance.zohoNumber}</span>
      )}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" className="text-[11px] text-sky-600 hover:underline">
          ↗
        </a>
      )}
      {glance.status === "UNKNOWN" || glance.status === "IN_FLIGHT" ? (
        <button
          type="button"
          onClick={() =>
            run(`rec-${key}`, async () => {
              const res = await reconcilePush(kind, docId, "doc");
              return res.ok ? { ok: true } : res;
            }, "Reconciled against Zoho.")
          }
          disabled={pending}
          className="rounded border border-purple-300 bg-purple-50 px-2 py-1 text-xs text-purple-700 hover:bg-purple-100 disabled:opacity-50"
        >
          {busyKey === `rec-${key}` ? "Checking…" : "Reconcile"}
        </button>
      ) : glance.status !== "SUCCESS" ? (
        <button
          type="button"
          onClick={() =>
            run(`push-${key}`, async () => {
              const res = await pushToZoho(kind, docId);
              if (!res.ok) return res;
              const bad = res.results.filter((x) => !x.ok);
              return bad.length ? { ok: false, error: bad[0].error ?? "Push failed." } : { ok: true };
            }, "Pushed to Zoho.")
          }
          disabled={pending}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
        >
          {busyKey === `push-${key}` ? "Pushing…" : glance.status === "FAILED" ? "Retry" : "Push"}
        </button>
      ) : null}
    </div>
  );
}

function InlinePoEditor({
  zohoPoId,
  lines,
  pending,
  busyKey,
  run,
  onDone,
}: {
  zohoPoId: string;
  lines: PoWorkspaceCard["lines"];
  pending: boolean;
  busyKey: string | null;
  run: RunFn;
  onDone: () => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.lineItemId, l.orderedQty])),
  );
  const changed = lines.filter(
    (l) => qty[l.lineItemId] !== undefined && !D(qty[l.lineItemId] || "0").eq(D(l.orderedQty)),
  );
  return (
    <div className="mx-3 mb-2 rounded-lg border border-sky-200 bg-sky-50/50 p-3">
      <p className="mb-2 text-xs text-neutral-500">
        Changes the LIVE Zoho purchase order. The receiving sheet updates immediately after saving.
      </p>
      <div className="space-y-1.5">
        {lines.map((l) => (
          <div key={l.lineItemId} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono text-xs text-neutral-600">{l.code ?? l.skuText}</span>{" "}
              <span className="text-neutral-700">{l.name}</span>
            </span>
            <span className="text-xs text-neutral-400">recvd {l.receivedQty}</span>
            <input
              type="number"
              step="0.001"
              inputMode="decimal"
              min={0}
              value={qty[l.lineItemId] ?? ""}
              onChange={(e) => setQty((q) => ({ ...q, [l.lineItemId]: e.target.value }))}
              className="w-28 rounded border border-neutral-300 bg-white px-2 py-1.5 text-right text-base focus:outline-none focus:ring-2 focus:ring-brand-600 md:py-1 md:text-sm"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || changed.length === 0}
          onClick={() => {
            if (
              window.confirm(
                `Save ${changed.length} quantity change(s) to the LIVE Zoho PO? This edits the real purchase order.`,
              )
            )
              run(
                `edit-${zohoPoId}`,
                async () => {
                  const res = await updateZohoPo({
                    zohoPoId,
                    lines: changed.map((l) => ({
                      lineItemId: l.lineItemId,
                      quantity: Number(qty[l.lineItemId]),
                    })),
                  });
                  if (res.ok) onDone();
                  return res;
                },
                "Zoho PO updated.",
              );
          }}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {busyKey === `edit-${zohoPoId}` ? "Saving…" : `Save to Zoho (${changed.length})`}
        </button>
        <span className="text-xs text-neutral-400">
          Quantities can’t go below what’s already received.
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- history */

function HistoryTab({ history, zohoUi }: { history: PushHistoryRow[]; zohoUi: ZohoUiBases }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const filtered = term
    ? history.filter(
        (h) =>
          h.kind.includes(term) ||
          String(h.docId).includes(term) ||
          (h.idemRef ?? "").toLowerCase().includes(term) ||
          (h.zohoNumber ?? "").toLowerCase().includes(term),
      )
    : history;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-400">
          Everything confirmed in Zoho, newest first ({history.length} records).
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by kind, doc #, reference…"
          className="w-64 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">When (IST)</th>
              <th className="px-4 py-2 font-medium">What</th>
              <th className="px-4 py-2 font-medium">Doc</th>
              <th className="px-4 py-2 font-medium">Reference</th>
              <th className="px-4 py-2 font-medium">Zoho record</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-neutral-400">
                  Nothing pushed yet
                </td>
              </tr>
            )}
            {filtered.map((h) => {
              const link = zohoRecordUrl(h.kind, h.zohoId, zohoUi);
              return (
                <tr key={h.id} className="border-t border-neutral-50">
                  <td className="px-4 py-1.5 text-xs text-neutral-500">
                    {h.pushedAt
                      ? new Date(h.pushedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
                      : "—"}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-600">{h.kind}</td>
                  <td className="px-4 py-1.5 text-neutral-700">
                    {h.docType} #{h.docId}
                    {h.subKey !== "doc" ? ` · ${h.subKey}` : ""}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-500">{h.idemRef ?? "—"}</td>
                  <td className="px-4 py-1.5">
                    {link ? (
                      <a href={link} target="_blank" rel="noreferrer" className="font-mono text-xs text-sky-600 hover:underline">
                        {h.zohoNumber ?? h.zohoId} ↗
                      </a>
                    ) : (
                      <span className="font-mono text-xs text-neutral-500">
                        {h.zohoNumber ?? h.zohoId ?? "—"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- combined stock */

function CombinedStock({ stock }: { stock: CombinedStockRow[] }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const filtered = term
    ? stock.filter(
        (r) => r.code.toLowerCase().includes(term) || r.name.toLowerCase().includes(term),
      )
    : stock;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-neutral-700">
          Combined stock — Zoho + not yet pushed
        </h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by code or name…"
          className="w-64 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">SKU</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 text-right font-medium">Zoho qty</th>
              <th className="px-4 py-2 text-right font-medium">Local Δ</th>
              <th className="px-4 py-2 text-right font-medium">Combined</th>
              <th className="px-4 py-2 font-medium">UOM</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-neutral-400">
                  No stock
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const delta = D(r.unpushedDelta);
              const nonZero = !delta.isZero();
              const signed = delta.gt(0) ? `+${r.unpushedDelta}` : r.unpushedDelta;
              return (
                <tr key={r.skuId} className="border-t border-neutral-50">
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-600">{r.code}</td>
                  <td className="px-4 py-1.5 text-neutral-700">{r.name}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-neutral-600">{r.zohoQty}</td>
                  <td
                    className={`px-4 py-1.5 text-right font-mono ${nonZero ? "text-amber-600" : "text-neutral-400"}`}
                  >
                    {nonZero ? signed : "—"}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono font-semibold text-neutral-800">
                    {r.combinedQty}
                  </td>
                  <td className="px-4 py-1.5 text-neutral-500">{r.uom}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-xs text-neutral-400">
        Zoho figure as of last Items sync. Local Δ clears only when the document is CONFIRMED pushed.
      </p>
    </div>
  );
}
