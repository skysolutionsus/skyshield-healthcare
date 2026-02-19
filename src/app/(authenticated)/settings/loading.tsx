export default function SettingsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto animate-in fade-in duration-300">
      <div className="mb-8">
        <div className="h-8 w-48 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
        <div className="h-4 w-56 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-2 animate-pulse" />
      </div>

      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-[var(--sky-border)] flex items-center gap-2">
          <div className="h-5 w-5 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
          <div className="h-5 w-36 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
        </div>
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-6 py-4 border-b border-[var(--sky-border)]"
          >
            <div className="w-9 h-9 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-full animate-pulse" />
            <div className="flex-1">
              <div className="h-4 w-32 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
              <div className="h-3 w-40 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-1 animate-pulse" />
            </div>
            <div className="h-5 w-20 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-full animate-pulse" />
            <div className="h-4 w-16 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="h-4 w-24 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}


