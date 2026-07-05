"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { newToken } from "@/lib/utils";
import { D, sumQty } from "@/lib/money";
import { pushDraftToZoho, type PushableDocType } from "@/actions/zoho-drafts";

export type SkuOpt = {
  id: number;
  code: string;
  name: string;
  channel: string;
  uom: string;
  packSizeText: string | null;
  motherSkuId: number | null;
};
type IdName = { id: number; name: string };
type InvOpt = {
  zohoInvoiceId: string;
  invoiceNumber: string | null;
  hint?: string | null;
};
type LoadInvoicesFn = (customerId: number) => Promise<InvOpt[]>;

/** A row seeded from an invoice line (returns). */
type ReturnLineSeed = {
  skuId: number | null;
  skuCode: string | null;
  itemName: string;
  uom: string | null;
  invoiceQty: string | null;
};
type LoadInvoiceLinesFn = (zohoInvoiceId: string) => Promise<ReturnLineSeed[]>;

export type EntryKind =
  | "receiving"
  | "sorting"
  | "regrade"
  | "assembly"
  | "wastage"
  | "return"
  | "adjustment"
  | "dispatch";

type ActionFn = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
) => Promise<
  { ok: true; docId: number; count?: number } | { ok: false; error: string }
>;

type Props = {
  kind: EntryKind;
  action: ActionFn;
  motherSkus?: SkuOpt[];
  packSkus?: SkuOpt[];
  allSkus?: SkuOpt[];
  vendors?: IdName[];
  customers?: IdName[];
  invoices?: InvOpt[];
  loadInvoices?: LoadInvoicesFn;
  loadInvoiceLines?: LoadInvoiceLinesFn;
  initialRows?: Row[];
  reasons?: { code: string; label: string }[];
  channel?: "BULK_FRUIT" | "BLINKIT" | "SPENCERS";
  /** Render the "Push to Zoho" button after a save (default false). */
  canPushToZoho?: boolean;
  /** Neutral caption under the push button: exactly where it lands in Zoho. */
  pushLabel?: string;
  /** Show the "+ Add row" button (default true). */
  allowAddRow?: boolean;
  /** Render a search box that filters the VISIBLE rows (typed values are
   *  kept — filtering never drops state). Value = placeholder text. */
  searchable?: string;
  /** When a SKU is picked, prefill `field` (if empty) with the current stock
   *  for that SKU and show it as a caption under the qty input. Used by
   *  Regrade: "Sorting quantity" starts at what's actually there. */
  stockPrefill?: { field: string; stock: Record<string, string>; unit?: string };
  /**
   * Interceptor run at the very start of save. Return `proceed:false` to abort
   * silently (the interceptor owns its own UX, e.g. a modal), or `patched` rows
   * to submit those instead of the current rows. Typed loosely — callers pass
   * their own row shape through.
   */
  beforeSubmit?: (
    rows: unknown[],
  ) =>
    | Promise<{ proceed: boolean; patched?: unknown[] }>
    | { proceed: boolean; patched?: unknown[] };
};

type Row = Record<string, string>;
const n = (v: string | undefined) => (v && v.trim() !== "" ? Number(v) : 0);
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");

function skuOpts(list: SkuOpt[] = []): Option[] {
  return list.map((s) => ({
    value: String(s.id),
    code: s.code,
    label: s.name,
    hint: s.packSizeText || s.channel,
  }));
}

/** Tabs that can push their saved document to Zoho as a draft.
 *  RETURN is deliberately absent — no Zoho mapping is wired for returns yet,
 *  so the button would only ever fail after the click. */
const PUSH_DOCTYPE: Partial<Record<EntryKind, PushableDocType>> = {
  receiving: "RECEIVING",
  assembly: "ASSEMBLY",
  adjustment: "INV_ADJUSTMENT",
  wastage: "WASTAGE",
};

export function EntryForm(props: Props) {
  const { kind, action } = props;
  const allowAddRow = props.allowAddRow ?? true;
  const showPush = props.canPushToZoho ?? false;
  const router = useRouter();
  const tokenRef = useRef(newToken());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const pushDocType = PUSH_DOCTYPE[kind];
  const [pushing, startPush] = useTransition();
  const [pushMsg, setPushMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [lastSaved, setLastSaved] = useState<{ docType: PushableDocType; docId: number } | null>(
    null,
  );

  const seedRows = useMemo(
    () => (props.initialRows && props.initialRows.length ? props.initialRows : [{}]),
    [props.initialRows],
  );
  const [header, setHeader] = useState<Row>({});
  const [rows, setRows] = useState<Row[]>(seedRows);
  // Adopt fresh server prelists after a save's router.refresh() (these pages
  // only refresh on save, so this never clobbers mid-edit typing).
  const [seenSeed, setSeenSeed] = useState(seedRows);
  if (seenSeed !== seedRows) {
    setSeenSeed(seedRows);
    setRows(seedRows);
  }
  const [invoiceOpts, setInvoiceOpts] = useState<InvOpt[]>(props.invoices ?? []);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  // sequence guards so a slow response can't overwrite a newer selection
  const invSeq = useRef(0);
  const lineSeq = useRef(0);

  // ----- header-driven population (done in handlers, not effects) -----
  // Returns: picking a customer (re)loads its recent invoices and clears rows.
  function selectCustomer(v: string) {
    setHeader((h) => ({ ...h, customerId: v, zohoInvoiceId: "" }));
    setRows([{}]);
    if (!props.loadInvoices || !v) {
      setInvoiceOpts([]);
      return;
    }
    const seq = ++invSeq.current;
    setLoadingInvoices(true);
    props
      .loadInvoices(Number(v))
      .then((opts) => seq === invSeq.current && setInvoiceOpts(opts))
      .catch(() => seq === invSeq.current && setInvoiceOpts([]))
      .finally(() => seq === invSeq.current && setLoadingInvoices(false));
  }

  // Returns: picking an invoice pre-fills locked rows from its lines.
  function selectInvoice(v: string) {
    setHeader((h) => ({ ...h, zohoInvoiceId: v }));
    if (!props.loadInvoiceLines || !v) {
      setRows([{}]);
      return;
    }
    const seq = ++lineSeq.current;
    props
      .loadInvoiceLines(v)
      .then((seeds) => {
        if (seq !== lineSeq.current) return;
        setRows(
          seeds.length
            ? seeds.map((s) => ({
                __locked: "1",
                skuId: s.skuId ? String(s.skuId) : "",
                skuCode: s.skuCode ?? "",
                itemName: s.itemName,
                uom: s.uom ?? "",
                qtyReturn: "",
                qtyWeight: "0",
                disposition: "",
              }))
            : [{}],
        );
      })
      .catch(() => seq === lineSeq.current && setRows([{}]));
  }

  const skuById = useMemo(() => {
    const m = new Map<number, SkuOpt>();
    for (const s of [
      ...(props.motherSkus ?? []),
      ...(props.packSkus ?? []),
      ...(props.allSkus ?? []),
    ])
      m.set(s.id, s);
    return m;
  }, [props.motherSkus, props.packSkus, props.allSkus]);

  function setCell(i: number, key: string, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, {}]);
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [{}]));
  }

  // ----- row search (render filter only — typed values always survive) -----
  const [query, setQuery] = useState("");
  const visibleRows = useMemo(() => {
    const indexed = rows.map((r, i) => ({ r, i }));
    const t = query.trim().toLowerCase();
    if (!props.searchable || !t) return indexed;
    return indexed.filter(({ r }) => {
      const sku = skuById.get(Number(r.skuId || r.packSkuId || 0));
      return [r.itemName, r.skuCode, r.poNo, r.vendorName, r.packSize, sku?.name, sku?.code]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t));
    });
  }, [rows, query, props.searchable, skuById]);

  // ----- computed values per kind -----
  // Sorting grades the full received batch, so waste is measured against the
  // carried Received qty; regrade measures against the entered Sorting qty.
  // Computed with Decimal (not native floats) to avoid drift like 0.001.
  const wasteBase = (r: Row) => (kind === "sorting" ? r.receivedQty : r.sortedQty);
  function waste(r: Row) {
    const base = wasteBase(r);
    const baseD = base && base.trim() !== "" ? D(base) : D(0);
    return baseD
      .minus(sumQty([r.qtyA || "0", r.qtyB || "0", r.qtyC || "0"]))
      .toNumber();
  }
  function used(r: Row) {
    return n(r.qtyOut) - n(r.qtyIn);
  }
  function toAdjust(r: Row) {
    return n(r.actualReceived) - n(r.qtyAsPerBill);
  }

  function buildPayload(
    srcRows: Row[] = rows,
  ): Record<string, unknown> | { error: string } {
    const clientToken = tokenRef.current;
    switch (kind) {
      case "receiving": {
        // One sheet can cover several open POs — group filled rows by their PO so
        // the batch action can post one receiving doc per PO. Rows with no PO
        // (manual + Add row) collapse into a single "" group. `poExpectedQty` is
        // the line's REMAINING qty (backend requirement); a per-line `variance`
        // scenario (JSON on the row, set by the page's beforeSubmit dialog) is
        // forwarded so the server can apply the S1/S2/S4 rules.
        const groups = new Map<
          string,
          { zohoPoId?: string; poNo?: string; lines: Record<string, unknown>[] }
        >();
        for (const r of srcRows) {
          if (!r.skuId || !r.acceptedQty) continue;
          const key = r.zohoPoId || "";
          if (!groups.has(key))
            groups.set(key, {
              zohoPoId: r.zohoPoId || undefined,
              poNo: r.poNo || undefined,
              lines: [],
            });
          let variance: unknown;
          if (r.__variance) {
            try {
              variance = JSON.parse(r.__variance);
            } catch {
              variance = undefined;
            }
          }
          groups.get(key)!.lines.push({
            skuId: Number(r.skuId),
            acceptedQty: r.acceptedQty,
            poExpectedQty: r.expectedQty || undefined,
            uom: skuById.get(Number(r.skuId))?.uom ?? r.uom ?? "kg",
            ...(variance ? { variance } : {}),
          });
        }
        return {
          clientToken,
          pos: [...groups.values()].filter((g) => g.lines.length),
        };
      }
      case "sorting":
        // Full-batch grade: sorted qty = the carried Received qty (no separate
        // input), so waste = Received − (A+B+C) and graded items fall off the sheet.
        return {
          clientToken,
          isRecheck: false,
          lines: srcRows
            .filter((r) => r.skuId && r.receivedQty)
            .map((r) => ({
              skuId: Number(r.skuId),
              sortedQty: r.receivedQty,
              qtyA: r.qtyA || "0",
              qtyB: r.qtyB || "0",
              qtyC: r.qtyC || "0",
            })),
        };
      case "regrade":
        // Re-grade of already-sorted stock: staff enter the quantity being
        // re-graded ("Sorting quantity" → sortedQty). Posts as a re-check.
        return {
          clientToken,
          isRecheck: true,
          lines: srcRows
            .filter((r) => r.skuId && r.sortedQty)
            .map((r) => ({
              skuId: Number(r.skuId),
              sortedQty: r.sortedQty,
              qtyA: r.qtyA || "0",
              qtyB: r.qtyB || "0",
              qtyC: r.qtyC || "0",
            })),
        };
      case "assembly":
        return {
          clientToken,
          channel: props.channel,
          lines: srcRows
            .filter((r) => r.motherSkuId && r.packSkuId && r.qtyOut && r.packsMade)
            .map((r) => ({
              motherSkuId: Number(r.motherSkuId),
              packSkuId: Number(r.packSkuId),
              qtyOut: r.qtyOut,
              qtyIn: r.qtyIn || "0",
              packsMade: r.packsMade,
              packSizeText: skuById.get(Number(r.packSkuId))?.packSizeText ?? undefined,
              // Bulk Fruit packs in the unit the packer chose; others are pieces.
              uom: props.channel === "BULK_FRUIT" ? r.uom || "box" : "pc",
              // Optional: part of `used` lost to trim/damage (record-only waste).
              qtyWaste: r.qtyWaste || "0",
              ...(r.wasteReason ? { wasteReason: r.wasteReason } : {}),
            })),
        };
      case "wastage":
        return {
          clientToken,
          lines: srcRows
            .filter((r) => r.skuId && r.qty && r.reason)
            .map((r) => ({
              skuId: Number(r.skuId),
              locationCode: r.locationCode || "COLD_ROOM",
              qty: r.qty,
              uom: skuById.get(Number(r.skuId))?.uom ?? "kg",
              reason: r.reason,
              source: "GENERAL",
            })),
        };
      case "return": {
        const inv = invoiceOpts.find((i) => i.zohoInvoiceId === header.zohoInvoiceId);
        return {
          clientToken,
          customerId: header.customerId ? Number(header.customerId) : null,
          zohoInvoiceId: header.zohoInvoiceId || undefined,
          invNo: inv?.invoiceNumber || undefined,
          matchStatus: header.zohoInvoiceId ? "MATCHED" : "PENDING_MATCH",
          lines: srcRows
            .filter((r) => r.skuId && r.qtyReturn && r.disposition)
            .map((r) => {
              const sku = skuById.get(Number(r.skuId));
              return {
                skuId: Number(r.skuId),
                qtyReturn: r.qtyReturn,
                qtyWeight: r.qtyWeight || "0",
                backToMotherSkuId: sku?.motherSkuId ?? null,
                disposition: r.disposition,
                uom: sku?.uom ?? "pc",
              };
            }),
        };
      }
      case "adjustment":
        return {
          clientToken,
          vendorId: header.vendorId ? Number(header.vendorId) : null,
          against: header.against,
          lines: srcRows
            .filter((r) => r.skuId && (r.qtyToAdjust || r.actualReceived || r.qtyAsPerBill))
            .map((r) => ({
              skuId: Number(r.skuId),
              locationCode: r.locationCode || "COLD_ROOM",
              qtyAsPerPo: r.qtyAsPerPo || undefined,
              actualReceived: r.actualReceived || undefined,
              qtyAsPerBill: r.qtyAsPerBill || undefined,
              qtyToAdjust:
                r.qtyToAdjust && r.qtyToAdjust !== ""
                  ? r.qtyToAdjust
                  : String(toAdjust(r)),
              adjKind: r.adjKind || "MANUAL",
              reason: r.reason,
            })),
        };
      case "dispatch":
        return {
          clientToken,
          customerId: header.customerId ? Number(header.customerId) : null,
          channel: props.channel ?? null,
          lines: srcRows
            .filter((r) => r.skuId && r.qty)
            .map((r) => ({
              packSkuId: Number(r.skuId),
              qty: r.qty,
              uom: skuById.get(Number(r.skuId))?.uom ?? "pc",
            })),
        };
    }
  }

  async function submit() {
    setMsg(null);
    // Interceptor OUTSIDE the transition: it may open a modal (receiving
    // variances) whose own state updates must render while we wait — awaiting
    // it inside startTransition would defer the modal's render and deadlock.
    let effectiveRows: Row[] = rows;
    if (props.beforeSubmit) {
      const r = await props.beforeSubmit(rows as unknown[]);
      if (!r.proceed) return;
      if (r.patched) effectiveRows = r.patched as Row[];
    }
    start(async () => {
      const payload = buildPayload(effectiveRows);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pAny = payload as any;
      // receiving groups its lines under `pos`; every other kind uses `lines`
      const lineCount =
        kind === "receiving"
          ? (pAny.pos ?? []).reduce(
              (a: number, g: { lines: unknown[] }) => a + g.lines.length,
              0,
            )
          : (pAny.lines?.length ?? 0);
      if (lineCount === 0) {
        setMsg({ type: "err", text: "Add at least one complete row." });
        return;
      }
      // Grades can't exceed the base qty (mirrors the DB CHECK on sorting_line).
      if (kind === "sorting" || kind === "regrade") {
        const bad = effectiveRows.some((r) => {
          const base = wasteBase(r);
          if (!r.skuId || !base || base.trim() === "") return false;
          return waste(r) < 0;
        });
        if (bad) {
          setMsg({
            type: "err",
            text:
              kind === "sorting"
                ? "Grades A+B+C can't exceed the Received quantity."
                : "Grades A+B+C can't exceed the Sorting quantity.",
          });
          return;
        }
      }
      const res = await action(payload);
      if (res.ok) {
        const count = res.count;
        setMsg({
          type: "ok",
          text:
            count && count > 1
              ? `Saved ✓ (${count} receipts)`
              : `Saved ✓ (document #${res.docId})`,
        });
        // remember the saved doc so it can be pushed to Zoho as a draft
        if (pushDocType && res.docId) {
          setLastSaved({ docType: pushDocType, docId: res.docId });
          setPushMsg(null);
        }
        // reset to the pristine pre-listed sheet (blank quantities) so the user
        // can keep going; a refresh re-pulls server data (e.g. drops received POs)
        setRows(seedRows);
        setHeader((h) => ({
          ...h,
          poNo: "",
          zohoPoId: "",
          poId: "",
          vendorName: "",
          against: "",
          zohoInvoiceId: "",
        }));
        tokenRef.current = newToken();
        router.refresh();
      } else {
        // keep rows + token so a retry is idempotent
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  function pushToZoho() {
    if (!lastSaved) return;
    setPushMsg(null);
    startPush(async () => {
      const res = await pushDraftToZoho(lastSaved.docType, lastSaved.docId);
      if (res.ok) {
        const ref = res.zohoNumber || res.zohoId || "draft";
        setPushMsg({
          type: "ok",
          text: res.alreadyExisted
            ? `Already in Zoho (${ref})`
            : `Draft created in Zoho ✓ (${ref})`,
        });
      } else {
        setPushMsg({ type: "err", text: res.error });
      }
    });
  }

  const cols = columnsFor(kind, props.channel);

  return (
    <div className="space-y-4">
      <HeaderFields
        kind={kind}
        header={header}
        setHeader={(k, v) => setHeader((h) => ({ ...h, [k]: v }))}
        vendors={props.vendors}
        customers={props.customers}
        invoices={invoiceOpts}
        loadingInvoices={loadingInvoices}
        onSelectCustomer={selectCustomer}
        onSelectInvoice={selectInvoice}
      />

      {props.searchable && (
        <div className="sticky top-14 z-20 -mx-1 rounded-lg bg-white/95 p-1 backdrop-blur md:static md:mx-0 md:bg-transparent md:p-0">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={props.searchable}
            className="w-full rounded-md border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-brand-600 md:max-w-sm md:py-1.5 md:text-sm"
          />
          {query.trim() !== "" && (
            <p className="mt-1 px-1 text-xs text-neutral-400">
              Showing {visibleRows.length} of {rows.length} rows — typed values on hidden rows are kept.
            </p>
          )}
        </div>
      )}

      {/* phones: one card per row (same fields via the shared cell renderer) */}
      <div className="space-y-3 md:hidden">
        {visibleRows.map(({ r, i }) => {
          const title =
            r.itemName ||
            skuById.get(Number(r.skuId || r.packSkuId || 0))?.name ||
            `Row ${i + 1}`;
          const sub = [r.poNo, r.vendorName].filter(Boolean).join(" · ");
          return (
            <div
              key={i}
              className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-neutral-800">
                    {title}
                  </div>
                  {sub && (
                    <div className="truncate text-[11px] text-neutral-400">{sub}</div>
                  )}
                </div>
                {!r.__locked && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="shrink-0 rounded-full px-2 py-0.5 text-neutral-300 hover:text-red-500"
                    title="remove row"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                {cols.map((c) => {
                  const wide =
                    c.type === "sku-mother" ||
                    c.type === "sku-pack" ||
                    c.type === "sku-all" ||
                    c.type === "select";
                  return (
                    <label
                      key={c.key}
                      className={`flex flex-col gap-0.5 ${wide ? "col-span-2" : ""}`}
                    >
                      <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                        {c.label}
                      </span>
                      {renderCell(c, r, i)}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* desktop: the classic sheet */}
      <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              {cols.map((c) => (
                <th key={c.key} className="px-2 py-2 font-medium">
                  {c.label}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ r, i }) => (
              <tr key={i} className="border-t border-neutral-100 align-top">
                {cols.map((c) => (
                  <td key={c.key} className="px-2 py-1.5">
                    {renderCell(c, r, i)}
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-neutral-300 hover:text-red-500"
                    title="remove row"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* sticky on phones so Save is always a thumb away */}
      <div className="sticky bottom-16 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-lg bg-white/95 p-1 backdrop-blur md:static md:bottom-auto md:mx-0 md:bg-transparent md:p-0">
        {allowAddRow && (
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 md:py-1.5"
          >
            + Add row
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-brand px-5 py-2 text-sm font-semibold text-ink hover:bg-brand-600 disabled:opacity-50 md:py-1.5"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {msg && (
          <span
            className={
              msg.type === "ok"
                ? "text-sm font-medium text-brand-800"
                : "text-sm font-medium text-red-600"
            }
          >
            {msg.text}
          </span>
        )}
        {showPush && pushDocType && (
          <div className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={pushToZoho}
                disabled={!lastSaved || pushing}
                title={
                  lastSaved
                    ? "Push the saved document to Zoho"
                    : "Save the document first, then push it to Zoho"
                }
                className="rounded-md border border-sky-300 bg-sky-50 px-4 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-40"
              >
                {pushing ? "Pushing…" : "Push to Zoho"}
              </button>
              {pushMsg && (
                <span
                  className={
                    pushMsg.type === "ok"
                      ? "text-sm font-medium text-sky-700"
                      : "text-sm font-medium text-red-600"
                  }
                >
                  {pushMsg.text}
                </span>
              )}
            </div>
            {props.pushLabel && (
              <span className="text-xs text-neutral-400">{props.pushLabel}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ---------- cell renderer ----------
  function renderCell(c: ColDef, r: Row, i: number) {
    if (c.type === "computed") {
      const v =
        c.key === "waste" ? waste(r) : c.key === "used" ? used(r) : toAdjust(r);
      return (
        <span
          className={
            "inline-block min-w-16 rounded bg-neutral-100 px-2 py-1 font-mono text-xs " +
            (v < 0 ? "text-red-600" : "text-neutral-700")
          }
        >
          {fmt(v)}
        </span>
      );
    }
    if (c.type === "display") {
      const sku = r[c.skuKey ?? "skuId"]
        ? skuById.get(Number(r[c.skuKey ?? "skuId"]))
        : undefined;
      // Receiving "Remaining" column: show the remaining qty, and (when the row
      // carries alreadyReceived metadata) a muted hint of the original order.
      if (c.key === "expectedQty" && r.alreadyReceived != null) {
        return (
          <div className="space-y-0.5">
            <span className="font-mono text-xs text-neutral-600">
              {r.expectedQty || "—"}
            </span>
            <span className="block text-[11px] text-neutral-400">
              of {r.orderedQty ?? r.expectedQty} ordered · {r.alreadyReceived}{" "}
              received
            </span>
          </div>
        );
      }
      let text = "";
      let mono = false;
      switch (c.key) {
        case "skuCode":
          text = sku?.code ?? r.skuCode ?? "";
          mono = true;
          break;
        case "itemName":
          text = sku?.name ?? r.itemName ?? "";
          break;
        case "uom":
          text = sku?.uom ?? r.uom ?? "";
          break;
        case "packSize":
          // row value first — assembly seeds "50 g · need 12" style hints
          text = r.packSize ?? sku?.packSizeText ?? "";
          break;
        case "expectedQty":
          text = r.expectedQty ?? "";
          mono = true;
          break;
        case "receivedQty":
          text = r.receivedQty ?? "";
          mono = true;
          break;
        case "poNo":
          text = r.poNo ?? "";
          mono = true;
          break;
        case "vendorName":
          text = r.vendorName ?? "";
          break;
        case "backToMother": {
          if (r.disposition === "WASTE") {
            text = "—";
          } else {
            const mom = sku?.motherSkuId ? skuById.get(sku.motherSkuId) : undefined;
            text = mom ? `${mom.code} · ${mom.name}` : sku ? "—" : "";
          }
          break;
        }
      }
      return (
        <span className={mono ? "font-mono text-xs text-neutral-600" : "text-sm text-neutral-700"}>
          {text || "—"}
        </span>
      );
    }
    if (c.type === "qty") {
      const nudge = (delta: number) => {
        const cur = r[c.key] && r[c.key].trim() !== "" ? D(r[c.key]) : D(0);
        const next = cur.plus(delta);
        setCell(i, c.key, (next.lt(0) ? D(0) : next).toString());
      };
      const stockHint =
        props.stockPrefill &&
        c.key === props.stockPrefill.field &&
        r.skuId &&
        props.stockPrefill.stock[r.skuId];
      return (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            {/* big thumb steppers on phones; typing stays the primary input */}
            <button
              type="button"
              onClick={() => nudge(-1)}
              aria-label={`decrease ${c.label}`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-xl font-medium text-neutral-600 active:bg-neutral-300 md:hidden"
            >
              −
            </button>
            <input
              type="number"
              step="0.001"
              inputMode="decimal"
              value={r[c.key] ?? ""}
              onChange={(e) => setCell(i, c.key, e.target.value)}
              // text-base on phones stops iOS auto-zoom; compact text-sm on desktop
              className="w-full rounded border border-neutral-300 px-2 py-1.5 text-right text-base focus:outline-none focus:ring-2 focus:ring-brand-600 md:w-24 md:py-1 md:text-sm"
            />
            <button
              type="button"
              onClick={() => nudge(1)}
              aria-label={`increase ${c.label}`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-xl font-medium text-neutral-600 active:bg-neutral-300 md:hidden"
            >
              +
            </button>
          </div>
          {stockHint && (
            <span className="block text-[11px] text-neutral-400">
              current stock: {stockHint}
              {props.stockPrefill?.unit ? ` ${props.stockPrefill.unit}` : ""} — edit if you're
              regrading less
            </span>
          )}
        </div>
      );
    }
    if (c.type === "select") {
      const opts =
        c.key === "reason" || c.key === "wasteReason"
          ? (props.reasons ?? []).map((x) => ({ value: x.code, label: x.label }))
          : (c.options ?? []);
      return (
        <SearchSelect
          className="min-w-36"
          options={opts as Option[]}
          value={r[c.key] ?? null}
          onChange={(v) => setCell(i, c.key, v ?? "")}
          placeholder={c.label}
        />
      );
    }
    // sku columns
    const list =
      c.type === "sku-mother"
        ? props.motherSkus
        : c.type === "sku-pack"
          ? props.packSkus
          : props.allSkus;

    // Locked rows came from a PO / invoice / pre-listed sheet: show the item
    // name, not a picker — keyed off THIS column's value (skuId / packSkuId /
    // motherSkuId). Unmatched upstream lines (no value) fall through to a picker.
    const valForCol = r[c.key];
    if (r.__locked === "1" && valForCol) {
      const sku = skuById.get(Number(valForCol));
      return (
        <span className="text-sm text-neutral-800">{sku?.name ?? r.itemName ?? "—"}</span>
      );
    }
    return (
      <div className="space-y-1">
        {r.__locked === "1" && r.itemName && (
          <div className="text-xs text-amber-600">⚠ {r.itemName} — pick SKU</div>
        )}
        <SearchSelect
          className="min-w-56"
          options={skuOpts(list)}
          value={r[c.key] ?? null}
          onChange={(v) => {
            setCell(i, c.key, v ?? "");
            // assembly: choosing the pack auto-selects its mother
            if (kind === "assembly" && c.key === "packSkuId" && v) {
              const mom = skuById.get(Number(v))?.motherSkuId;
              if (mom) setCell(i, "motherSkuId", String(mom));
            }
            // regrade: prefill the qty field with current stock (editable)
            if (props.stockPrefill && v && (!r[props.stockPrefill.field] || r[props.stockPrefill.field].trim() === "")) {
              const stock = props.stockPrefill.stock[v];
              if (stock) setCell(i, props.stockPrefill.field, stock);
            }
          }}
          placeholder="Search SKU…"
        />
      </div>
    );
  }
}

/* ----------------------------- column specs ----------------------------- */
type ColType =
  | "sku-mother"
  | "sku-pack"
  | "sku-all"
  | "qty"
  | "computed"
  | "select"
  | "display"
  | "text";
type ColDef = {
  key: string;
  label: string;
  type: ColType;
  options?: Option[];
  /** for `display` columns, which row key holds the SKU id (default "skuId"). */
  skuKey?: string;
};

const UOM_OPTS: Option[] = [
  { value: "box", label: "Box" },
  { value: "kg", label: "Kg" },
  { value: "pc", label: "Pieces" },
  { value: "bunch", label: "Bunch" },
  { value: "unit", label: "Unit" },
];

function columnsFor(kind: EntryKind, channel?: string): ColDef[] {
  const loc: Option[] = [
    { value: "COLD_ROOM", label: "Cold Room" },
    { value: "DC_FLOOR_FG", label: "Finished Goods" },
  ];
  const disp: Option[] = [
    { value: "RESALABLE", label: "Resalable → mother" },
    { value: "WASTE", label: "Waste" },
  ];
  const adj: Option[] = [
    { value: "MANUAL", label: "Manual" },
    { value: "TIE_OUT", label: "PO/Bill tie-out" },
    { value: "OVERRIDE", label: "Override" },
  ];
  switch (kind) {
    case "receiving":
      return [
        { key: "poNo", label: "PO", type: "display" },
        { key: "vendorName", label: "Vendor", type: "display" },
        { key: "skuId", label: "Item (mother SKU)", type: "sku-mother" },
        { key: "skuCode", label: "SKU", type: "display" },
        { key: "uom", label: "UOM", type: "display" },
        { key: "expectedQty", label: "Remaining", type: "display" },
        { key: "acceptedQty", label: "Accepted qty", type: "qty" },
      ];
    case "sorting":
      return [
        { key: "skuId", label: "Item (mother SKU)", type: "sku-mother" },
        { key: "skuCode", label: "SKU", type: "display" },
        { key: "vendorName", label: "Vendor", type: "display" },
        { key: "receivedQty", label: "Received", type: "display" },
        { key: "qtyA", label: "Grade A", type: "qty" },
        { key: "qtyB", label: "Grade B", type: "qty" },
        { key: "qtyC", label: "Grade C", type: "qty" },
        { key: "waste", label: "Waste (auto)", type: "computed" },
      ];
    case "regrade":
      // Re-grade already-sorted stock: no vendor / received reference; staff
      // enter the quantity being re-graded. SKU code auto-fills from the item.
      return [
        { key: "skuId", label: "Item (mother SKU)", type: "sku-mother" },
        { key: "skuCode", label: "SKU", type: "display" },
        { key: "sortedQty", label: "Sorting quantity (kg)", type: "qty" },
        { key: "qtyA", label: "Grade A", type: "qty" },
        { key: "qtyB", label: "Grade B", type: "qty" },
        { key: "qtyC", label: "Grade C", type: "qty" },
        { key: "waste", label: "Waste (auto)", type: "computed" },
      ];
    case "assembly":
      // Bulk Fruit is sold loose / by weight — no fixed pack size; the packer
      // records a quantity + picks its unit, instead of a pack-size column.
      if (channel === "BULK_FRUIT")
        return [
          { key: "packSkuId", label: "Pack made", type: "sku-pack" },
          { key: "skuCode", label: "SKU", type: "display", skuKey: "packSkuId" },
          { key: "motherSkuId", label: "From (mother)", type: "sku-mother" },
          { key: "qtyOut", label: "Out from CR (kg)", type: "qty" },
          { key: "qtyIn", label: "Back to CR (kg)", type: "qty" },
          { key: "used", label: "Used (auto)", type: "computed" },
          { key: "packsMade", label: "Quantity", type: "qty" },
          { key: "uom", label: "UOM", type: "select", options: UOM_OPTS },
          { key: "qtyWaste", label: "Waste (kg)", type: "qty" },
          { key: "wasteReason", label: "Waste reason", type: "select" },
        ];
      return [
        { key: "packSkuId", label: "Pack made", type: "sku-pack" },
        { key: "skuCode", label: "SKU", type: "display", skuKey: "packSkuId" },
        { key: "packSize", label: "Pack size", type: "display", skuKey: "packSkuId" },
        { key: "motherSkuId", label: "From (mother)", type: "sku-mother" },
        { key: "qtyOut", label: "Out from CR (kg)", type: "qty" },
        { key: "qtyIn", label: "Back to CR (kg)", type: "qty" },
        { key: "used", label: "Used (auto)", type: "computed" },
        { key: "packsMade", label: "Packs made", type: "qty" },
        { key: "qtyWaste", label: "Waste (kg)", type: "qty" },
        { key: "wasteReason", label: "Waste reason", type: "select" },
      ];
    case "wastage":
      return [
        { key: "skuId", label: "Item", type: "sku-all" },
        { key: "skuCode", label: "SKU", type: "display" },
        { key: "uom", label: "UOM", type: "display" },
        { key: "locationCode", label: "Location", type: "select", options: loc },
        { key: "qty", label: "Qty", type: "qty" },
        { key: "reason", label: "Reason", type: "select" }, // options injected below
      ];
    case "return":
      return [
        { key: "skuId", label: "Pack returned", type: "sku-pack" },
        { key: "skuCode", label: "SKU", type: "display" },
        { key: "uom", label: "UOM", type: "display" },
        { key: "qtyReturn", label: "Qty returned", type: "qty" },
        { key: "qtyWeight", label: "Weight back (kg)", type: "qty" },
        { key: "backToMother", label: "Back to mother", type: "display" },
        { key: "disposition", label: "Disposition", type: "select", options: disp },
      ];
    case "adjustment":
      return [
        { key: "skuId", label: "Item", type: "sku-all" },
        { key: "skuCode", label: "SKU", type: "display" },
        { key: "uom", label: "UOM", type: "display" },
        { key: "locationCode", label: "Location", type: "select", options: loc },
        { key: "qtyAsPerPo", label: "As per PO", type: "qty" },
        { key: "actualReceived", label: "Actual recvd", type: "qty" },
        { key: "qtyAsPerBill", label: "As per bill", type: "qty" },
        { key: "qtyToAdjust", label: "To adjust (auto*)", type: "qty" },
        { key: "adjKind", label: "Kind", type: "select", options: adj },
      ];
    case "dispatch":
      return [
        { key: "skuId", label: "Pack dispatched", type: "sku-pack" },
        { key: "qty", label: "Qty (packs)", type: "qty" },
      ];
  }
}

/* ----------------------------- header fields ----------------------------- */
function HeaderFields({
  kind,
  header,
  setHeader,
  vendors = [],
  customers = [],
  invoices = [],
  loadingInvoices = false,
  onSelectCustomer,
  onSelectInvoice,
}: {
  kind: EntryKind;
  header: Row;
  setHeader: (k: string, v: string) => void;
  vendors?: IdName[];
  customers?: IdName[];
  invoices?: InvOpt[];
  loadingInvoices?: boolean;
  onSelectCustomer: (v: string) => void;
  onSelectInvoice: (v: string) => void;
}) {
  const vOpts: Option[] = vendors.map((v) => ({ value: String(v.id), label: v.name }));
  const cOpts: Option[] = customers.map((c) => ({ value: String(c.id), label: c.name }));
  const iOpts: Option[] = invoices.map((i) => ({
    value: i.zohoInvoiceId,
    label: i.invoiceNumber || i.zohoInvoiceId,
    hint: i.hint || undefined,
  }));

  const wrap = "flex flex-wrap items-end gap-4";
  const field = "flex flex-col gap-1";
  const lbl = "text-xs font-medium text-neutral-500";

  // Receiving / Sorting / Regrade have no header — rows are pre-listed (sorting)
  // or added manually (regrade); re-grade has moved to its own tab.
  if (kind === "return")
    return (
      <div className={wrap}>
        <div className={field}>
          <span className={lbl}>Customer</span>
          <SearchSelect className="w-56" options={cOpts} value={header.customerId ?? null} onChange={(v) => onSelectCustomer(v ?? "")} placeholder={customers.length ? "Customer" : "Sync customers from Zoho"} />
        </div>
        <div className={field}>
          <span className={lbl}>Against invoice</span>
          <SearchSelect
            className="w-56"
            options={iOpts}
            value={header.zohoInvoiceId ?? null}
            onChange={(v) => onSelectInvoice(v ?? "")}
            disabled={!header.customerId || loadingInvoices}
            placeholder={
              !header.customerId
                ? "Pick a customer first"
                : loadingInvoices
                  ? "Loading invoices…"
                  : invoices.length
                    ? "Invoice"
                    : "No recent invoices"
            }
          />
        </div>
      </div>
    );
  if (kind === "adjustment")
    return (
      <div className={wrap}>
        <div className={field}>
          <span className={lbl}>Vendor</span>
          <SearchSelect className="w-56" options={vOpts} value={header.vendorId ?? null} onChange={(v) => setHeader("vendorId", v ?? "")} placeholder="Vendor (optional)" />
        </div>
        <TextField label="Against" value={header.against} onChange={(v) => setHeader("against", v)} />
      </div>
    );
  if (kind === "dispatch")
    return (
      <div className={wrap}>
        <div className={field}>
          <span className={lbl}>Customer</span>
          <SearchSelect className="w-56" options={cOpts} value={header.customerId ?? null} onChange={(v) => setHeader("customerId", v ?? "")} placeholder="Customer (optional)" />
        </div>
      </div>
    );
  return null;
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-36 rounded border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
      />
    </div>
  );
}
