export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-neutral-900">{title}</h1>
      {subtitle && <p className="mt-0.5 text-sm text-neutral-500">{subtitle}</p>}
    </div>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      {children}
    </div>
  );
}
