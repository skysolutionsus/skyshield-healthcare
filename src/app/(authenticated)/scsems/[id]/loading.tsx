export default function SCSEMDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl animate-in p-4 fade-in duration-300 sm:p-6 lg:p-8">
      <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-6" />

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-gray-200 dark:bg-gray-800 rounded-xl animate-pulse" />
          <div className="flex-1">
            <div className="h-6 w-64 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="flex gap-3 mt-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse"
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 text-center"
          >
            <div className="h-8 w-12 bg-gray-200 dark:bg-gray-800 rounded mx-auto animate-pulse" />
            <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded mx-auto mt-2 animate-pulse" />
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 mb-4">
        <div className="flex gap-3">
          <div className="h-9 w-48 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
          <div className="h-9 w-32 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
        </div>
      </div>

      <div className="space-y-2">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4"
          >
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-4 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-4 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="ml-auto h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
