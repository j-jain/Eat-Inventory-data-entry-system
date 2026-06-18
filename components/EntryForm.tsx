"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { SearchSelect, type Option } from "@/components/SearchSelect";
import { newToken } from "@/lib/utils";

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
  customerName: string | null;
};

export type EntryKind =
  | "receiving"
  | "sorting"
  | "assembly"
  | "wastage"
  | "return"
  | "adjustment"
  | "dispatch";

type ActionFn = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
) => Promise<{ ok: true; docId: number } | { ok: false; error: string }>;

type Props = {
  kind: EntryKind;
  action: ActionFn;
  motherSkus?: SkuOpt[];
  packSkus?: SkuOpt[];
  allSkus?: SkuOpt[];
  vendors?: IdName[];
  customers?: IdName[];
  invoices?: InvOpt[];
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

export function EntryForm(props: Props) {
  const { kind, action } = props;
  const tokenRef = useRef(newToken());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [header, setHeader] = useState<Row>({});
  const [rows, setRows] = useState<Row[]>([{}]);

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
    setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  }

  // ----- computed values per kind -----
  function waste(r: Row) {
    return n(r.sortedQty) - (n(r.qtyA) + n(r.qtyB) + n(r.qtyC));
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
      case "receiving":
        return {
          clientToken,
          vendorId: header.vendorId ? Number(header.vendorId) : null,
          poNo: header.poNo,
          prNo: header.prNo,
          lines: rows
            .filter((r) => r.skuId && r.acceptedQty)
            .map((r) => ({
              skuId: Number(r.skuId),
              acceptedQty: r.acceptedQty,
              uom: skuById.get(Number(r.skuId))?.uom ?? "kg",
            })),
        };
      case "sorting":
        return {
          clientToken,
          isRecheck: header.isRecheck === "1",
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
      case "return":
        return {
          clientToken,
          customerId: header.customerId ? Number(header.customerId) : null,
          zohoInvoiceId: header.zohoInvoiceId || undefined,
          invNo: header.invNo || undefined,
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
    const lines = (payload as any).lines as unknown[] | undefined;
    if (!lines || lines.length === 0) {
      setMsg({ type: "err", text: "Add at least one complete row." });
      return;
    }
    setMsg(null);
    start(async () => {
      const res = await action(payload);
      if (res.ok) {
        setMsg({ type: "ok", text: `Saved ✓ (document #${res.docId})` });
        setRows([{}]);
        setHeader((h) => ({ ...h, poNo: "", prNo: "", against: "" }));
        tokenRef.current = newToken();
      } else {
        // keep rows + token so a retry is idempotent
        setMsg({ type: "err", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-4">
      <HeaderFields
        kind={kind}
        header={header}
        setHeader={(k, v) => setHeader((h) => ({ ...h, [k]: v }))}
        vendors={props.vendors}
        customers={props.customers}
        invoices={props.invoices}
      />

      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              {columnsFor(kind).map((c) => (
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
                {columnsFor(kind).map((c) => (
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

      <div className="flex items-center gap-3">
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
    return (
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
  | "text";
type ColDef = { key: string; label: string; type: ColType; options?: Option[] };

function columnsFor(kind: EntryKind): ColDef[] {
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
        { key: "skuId", label: "Item (mother SKU)", type: "sku-mother" },
        { key: "acceptedQty", label: "Accepted qty (kg)", type: "qty" },
      ];
    case "sorting":
      return [
        { key: "skuId", label: "Item (mother SKU)", type: "sku-mother" },
        { key: "sortedQty", label: "Sorted qty (kg)", type: "qty" },
        { key: "qtyA", label: "Grade A", type: "qty" },
        { key: "qtyB", label: "Grade B", type: "qty" },
        { key: "qtyC", label: "Grade C", type: "qty" },
        { key: "waste", label: "Waste (auto)", type: "computed" },
      ];
    case "assembly":
      return [
        { key: "packSkuId", label: "Pack made", type: "sku-pack" },
        { key: "motherSkuId", label: "From (mother)", type: "sku-mother" },
        { key: "qtyOut", label: "Out from CR (kg)", type: "qty" },
        { key: "qtyIn", label: "Back to CR (kg)", type: "qty" },
        { key: "used", label: "Used (auto)", type: "computed" },
        { key: "packsMade", label: "Packs made", type: "qty" },
      ];
    case "wastage":
      return [
        { key: "skuId", label: "Item", type: "sku-all" },
        { key: "locationCode", label: "Location", type: "select", options: loc },
        { key: "qty", label: "Qty", type: "qty" },
        { key: "reason", label: "Reason", type: "select" }, // options injected below
      ];
    case "return":
      return [
        { key: "skuId", label: "Pack returned", type: "sku-pack" },
        { key: "qtyReturn", label: "Qty returned", type: "qty" },
        { key: "qtyWeight", label: "Weight back (kg)", type: "qty" },
        { key: "disposition", label: "Disposition", type: "select", options: disp },
      ];
    case "adjustment":
      return [
        { key: "skuId", label: "Item", type: "sku-all" },
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
}: {
  kind: EntryKind;
  header: Row;
  setHeader: (k: string, v: string) => void;
  vendors?: IdName[];
  customers?: IdName[];
  invoices?: InvOpt[];
}) {
  const vOpts: Option[] = vendors.map((v) => ({ value: String(v.id), label: v.name }));
  const cOpts: Option[] = customers.map((c) => ({ value: String(c.id), label: c.name }));
  const iOpts: Option[] = invoices.map((i) => ({
    value: i.zohoInvoiceId,
    label: i.invoiceNumber || i.zohoInvoiceId,
    hint: i.customerName || undefined,
  }));

  const wrap = "flex flex-wrap items-end gap-4";
  const field = "flex flex-col gap-1";
  const lbl = "text-xs font-medium text-neutral-500";

  if (kind === "receiving")
    return (
      <div className={wrap}>
        <div className={field}>
          <span className={lbl}>Vendor</span>
          <SearchSelect className="w-56" options={vOpts} value={header.vendorId ?? null} onChange={(v) => setHeader("vendorId", v ?? "")} placeholder={vendors.length ? "Vendor" : "Sync vendors from Zoho"} />
        </div>
        <TextField label="PO No" value={header.poNo} onChange={(v) => setHeader("poNo", v)} />
        <TextField label="PR No" value={header.prNo} onChange={(v) => setHeader("prNo", v)} />
      </div>
    );
  if (kind === "sorting")
    return (
      <div className={wrap}>
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          <input
            type="checkbox"
            checked={header.isRecheck === "1"}
            onChange={(e) => setHeader("isRecheck", e.target.checked ? "1" : "")}
          />
          This is a re-check of already-sorted stock
        </label>
      </div>
    );
  if (kind === "return")
    return (
      <div className={wrap}>
        <div className={field}>
          <span className={lbl}>Customer</span>
          <SearchSelect className="w-56" options={cOpts} value={header.customerId ?? null} onChange={(v) => setHeader("customerId", v ?? "")} placeholder={customers.length ? "Customer" : "Sync customers from Zoho"} />
        </div>
        <div className={field}>
          <span className={lbl}>Against invoice</span>
          <SearchSelect className="w-56" options={iOpts} value={header.zohoInvoiceId ?? null} onChange={(v) => setHeader("zohoInvoiceId", v ?? "")} placeholder={invoices.length ? "Invoice" : "Sync invoices from Zoho"} />
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
