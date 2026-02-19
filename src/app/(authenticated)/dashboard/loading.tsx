import { Loader2 } from "lucide-react";

export default function DashboardLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-in fade-in duration-300">
      <div className="mb-8">
        <div className="h-8 w-40 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse" />
        <div className="h-4 w-64 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded mt-2 animate-pulse" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="h-4 w-24 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
              <div className="h-5 w-5 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            </div>
            <div className="h-9 w-16 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse" />
            <div className="mt-2 h-2 w-full bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-full animate-pulse" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6">
          <div className="h-6 w-32 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse mb-4" />
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="h-12 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg animate-pulse"
              />
            ))}
          </div>
        </div>
        <div className="lg:col-span-2 bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6">
          <div className="h-6 w-36 bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded animate-pulse mb-4" />
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        </div>
      </div>
    </div>
  );
}


