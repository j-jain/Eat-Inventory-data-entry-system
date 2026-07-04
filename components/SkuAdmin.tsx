"use client";

import { useMemo, useState, useTransition } from "react";
import { setSkuActive, addSku, type AddSkuInput } from "@/actions/skus";

type SkuRow = {
  id: number;
  code: string;
  name: string;
  channel: string;
  uom: string;
  packSizeText: string | null;
  skuKind: string;
  isActive: boolean;
};

export function SkuAdmin({ skus }: { skus: SkuRow[] }) {
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const [rows, setRows] = useState(skus);
  const [form, setForm] = useState<AddSkuInput>({
    code: "",
    name: "",
    kind: "DERIVATIVE",
    uom: "pc",
    packText: "",
  });
  const [msg, setMsg] = useState<string | null>(null);

  const term = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      term
        ? rows.filter(
            (r) =>
              r.code.toLowerCase().includes(term) ||
              r.name.toLowerCase().includes(term) ||
              r.channel.toLowerCase().includes(term),
          )
        : rows,
    [rows, term],
  );

  function toggle(id: number, active: boolean) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, isActive: active } : r)));
    start(async () => {
      await setSkuActive(id, active);
    });
  }

  function add() {
    setMsg(null);
    start(async () => {
      const res = await addSku(form);
      if (res.ok) {
        setMsg("Added ✓ (reload to see in list)");
        setForm({ code: "", name: "", kind: "DERIVATIVE", uom: "pc", packText: "" });
      } else setMsg(res.error);
    });
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-neutral-700">Add SKU</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Inp label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} />
          <Inp label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} wide />
          <Sel
            label="Kind"
            value={form.kind}
            opts={["MOTHER", "DERIVATIVE"]}
            onChange={(v) => setForm({ ...form, kind: v as AddSkuInput["kind"] })}
          />
          <Sel
            label="UOM"
            value={form.uom}
            opts={["kg", "g", "pc", "box", "bunch", "unit"]}
            onChange={(v) => setForm({ ...form, uom: v as AddSkuInput["uom"] })}
          />
          <Inp label="Pack size" value={form.packText ?? ""} onChange={(v) => setForm({ ...form, packText: v })} />
          <button
            type="button"
            onClick={add}
            disabled={pending}
            className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-ink hover:bg-brand-600 disabled:opacity-50"
          >
            Add
          </button>
          {msg && <span className="text-sm text-neutral-600">{msg}</span>}
        </div>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter SKUs…"
        className="w-72 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
      />

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">Code</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Channel</th>
              <th className="px-4 py-2 font-medium">Pack</th>
              <th className="px-4 py-2 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 400).map((r) => (
              <tr key={r.id} className="border-t border-neutral-50">
                <td className="px-4 py-1.5 font-mono text-xs">{r.code}</td>
                <td className="px-4 py-1.5">{r.name}</td>
                <td className="px-4 py-1.5 text-neutral-500">{r.channel}</td>
                <td className="px-4 py-1.5 text-neutral-500">{r.packSizeText ?? "—"}</td>
                <td className="px-4 py-1.5">
                  <input
                    type="checkbox"
                    checked={r.isActive}
                    onChange={(e) => toggle(r.id, e.target.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-400">Showing {Math.min(filtered.length, 400)} of {filtered.length}.</p>
    </div>
  );
}

function Inp({
  label,
  value,
  onChange,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  wide?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${wide ? "w-56" : "w-32"} rounded border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600`}
      />
    </div>
  );
}

function Sel({
  label,
  value,
  opts,
  onChange,
}: {
  label: string;
  value: string;
  opts: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
