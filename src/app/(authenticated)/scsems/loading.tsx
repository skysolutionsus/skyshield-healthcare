export default function SCSEMsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-in fade-in duration-300">
      <div className="mb-6">
        <div className="h-8 w-44 rounded-lg bg-[var(--sky-surface-overlay)] animate-pulse" />
        <div className="mt-2 h-4 w-96 max-w-full rounded bg-[var(--sky-surface-overlay)] animate-pulse" />
      </div>

      <div className="mb-6 rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
        <div className="min-h-[176px] rounded-lg border border-dashed border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] animate-pulse" />
      </div>

      <div className="rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          {[...Array(4)].map((_, index) => (
            <div key={index} className="h-16 rounded-lg bg-[var(--sky-surface-overlay)] animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
