export default function SCSEMsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-in fade-in duration-300">
      <div className="mb-8">
        <div className="h-8 w-48 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
        <div className="h-4 w-80 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-2 animate-pulse" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-5"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
              <div>
                <div className="h-7 w-12 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
                <div className="h-3 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-1 animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {[...Array(3)].map((_, g) => (
        <div key={g} className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
            <div className="h-6 w-28 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-5"
              >
                <div className="h-4 w-full bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse mb-3" />
                <div className="h-3 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse mb-3" />
                <div className="flex justify-between">
                  <div className="h-5 w-16 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
                  <div className="h-5 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-full animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}


