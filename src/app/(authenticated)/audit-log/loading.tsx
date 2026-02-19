export default function AuditLogLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-in fade-in duration-300">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="h-8 w-36 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
          <div className="h-4 w-72 bg-gray-200 dark:bg-gray-800 rounded mt-2 animate-pulse" />
        </div>
        <div className="h-5 w-28 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
      </div>

      <div className="flex gap-2 mb-6">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-9 w-28 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse"
          />
        ))}
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex gap-4">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse"
              />
            ))}
          </div>
        </div>
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="flex gap-4 px-4 py-3 border-b border-gray-100 dark:border-gray-800"
          >
            <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-28 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse font-mono" />
          </div>
        ))}
      </div>
    </div>
  );
}
