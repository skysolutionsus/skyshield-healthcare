export default function AuditLogLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl animate-in p-4 fade-in duration-300 sm:p-6 lg:p-8">
      <div className="mb-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="h-8 w-36 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
          <div className="h-4 w-72 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-2 animate-pulse" />
        </div>
        <div className="h-5 w-28 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
      </div>

      <div className="flex gap-2 mb-6">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-9 w-28 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse"
          />
        ))}
      </div>

      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--sky-border)]">
          <div className="flex gap-4">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="h-4 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse"
              />
            ))}
          </div>
        </div>
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="flex gap-4 px-4 py-3 border-b border-[var(--sky-border)]"
          >
            <div className="h-4 w-32 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-24 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-28 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-16 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-24 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse font-mono" />
          </div>
        ))}
      </div>
    </div>
  );
}


