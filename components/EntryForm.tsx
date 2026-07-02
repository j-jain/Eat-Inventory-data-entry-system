"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { newToken } from "@/lib/utils";
import { D, sumQty } from "@/lib/money";
import { pushDraftToZoho } from "@/actions/zoho-drafts";
import type { PushableDocType } from "@/lib/zoho/drafts";

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

/** Tabs that can push their saved document to Zoho as a draft. */
const PUSH_DOCTYPE: Partial<Record<EntryKind, PushableDocType>> = {
  receiving: "RECEIVING",
  assembly: "ASSEMBLY",
  adjustment: "INV_ADJUSTMENT",
  wastage: "WASTAGE",
  return: "RETURN",
};

export function EntryForm(props: Props) {
  const { kind, action } = props;
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

  function buildPayload(): Record<string, unknown> | { error: string } {
    const clientToken = tokenRef.current;
    switch (kind) {
      case "receiving": {
        // One sheet can cover several open POs — group filled rows by their PO so
        // the batch action can post one receiving doc per PO. Rows with no PO
        // (manual + Add row) collapse into a single "" group.
        const groups = new Map<
          string,
          { zohoPoId?: string; poNo?: string; lines: Record<string, unknown>[] }
        >();
        for (const r of rows) {
          if (!r.skuId || !r.acceptedQty) continue;
          const key = r.zohoPoId || "";
          if (!groups.has(key))
            groups.set(key, {
              zohoPoId: r.zohoPoId || undefined,
              poNo: r.poNo || undefined,
              lines: [],
            });
          groups.get(key)!.lines.push({
            skuId: Number(r.skuId),
            acceptedQty: r.acceptedQty,
            poExpectedQty: r.expectedQty || undefined,
            uom: skuById.get(Number(r.skuId))?.uom ?? r.uom ?? "kg",
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
          lines: rows
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
          lines: rows
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
          lines: rows
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
            })),
        };
      case "wastage":
        return {
          clientToken,
          lines: rows
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
          lines: rows
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
          lines: rows
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
          lines: rows
            .filter((r) => r.skuId && r.qty)
            .map((r) => ({
              packSkuId: Number(r.skuId),
              qty: r.qty,
              uom: skuById.get(Number(r.skuId))?.uom ?? "pc",
            })),
        };
    }
  }

  function submit() {
    const payload = buildPayload();
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
      const bad = rows.some((r) => {
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
    setMsg(null);
    start(async () => {
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

      <div className="overflow-x-auto rounded-lg border border-neutral-200">
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
            {rows.map((r, i) => (
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

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addRow}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
        >
          + Add row
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {msg && (
          <span
            className={
              msg.type === "ok"
                ? "text-sm font-medium text-emerald-700"
                : "text-sm font-medium text-red-600"
            }
          >
            {msg.text}
          </span>
        )}
        {pushDocType && (
          <button
            type="button"
            onClick={pushToZoho}
            disabled={!lastSaved || pushing}
            title={
              lastSaved
                ? "Create a draft of the saved document in Zoho"
                : "Save the document first, then push it to Zoho"
            }
            className="rounded-md border border-sky-300 bg-sky-50 px-4 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-40"
          >
            {pushing ? "Pushing…" : "Push draft to Zoho"}
          </button>
        )}
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
          text = sku?.packSizeText ?? r.packSize ?? "";
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
      return (
        <input
          type="number"
          step="0.001"
          inputMode="decimal"
          value={r[c.key] ?? ""}
          onChange={(e) => setCell(i, c.key, e.target.value)}
          className="w-24 rounded border border-neutral-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      );
    }
    if (c.type === "select") {
      const opts =
        c.key === "reason"
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
        { key: "expectedQty", label: "Expected", type: "display" },
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
        className="w-36 rounded border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
    </div>
  );
}
