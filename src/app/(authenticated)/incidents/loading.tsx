export default function IncidentsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-in fade-in duration-300">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="h-8 w-44 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
          <div className="h-4 w-72 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-2 animate-pulse" />
        </div>
        <div className="h-10 w-36 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
      </div>

      <div className="flex gap-2 mb-6">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="h-9 w-24 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse"
          />
        ))}
      </div>

      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--sky-border)]">
          <div className="flex gap-4">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="h-4 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse"
              />
            ))}
          </div>
        </div>
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="flex gap-4 px-4 py-4 border-b border-[var(--sky-border)]"
          >
            <div className="h-4 w-48 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-28 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-5 w-16 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-full animate-pulse" />
            <div className="h-5 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-full animate-pulse" />
            <div className="h-4 w-24 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}


