export default function IncidentDetailLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-in fade-in duration-300">
      <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-6" />

      <div className="mb-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-8 w-64 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
          <div className="h-6 w-16 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
          <div className="h-6 w-20 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
        </div>
        <div className="flex gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-4 w-28 bg-gray-200 dark:bg-gray-800 rounded animate-pulse"
            />
          ))}
        </div>
      </div>

      {/* Status progress bar skeleton */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center flex-1 last:flex-initial">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
                <div className="h-3 w-14 bg-gray-200 dark:bg-gray-800 rounded mt-1.5 animate-pulse" />
              </div>
              {i < 4 && <div className="flex-1 h-0.5 mx-2 bg-gray-200 dark:bg-gray-800" />}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6"
            >
              <div className="h-5 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-3" />
              <div className="space-y-2">
                <div className="h-4 w-full bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                <div className="h-4 w-3/4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-6">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
            <div className="h-5 w-28 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-4" />
            <div className="space-y-3">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="h-10 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
