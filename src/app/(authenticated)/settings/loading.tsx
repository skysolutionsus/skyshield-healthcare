export default function SettingsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto animate-in fade-in duration-300">
      <div className="mb-8">
        <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
        <div className="h-4 w-56 bg-gray-200 dark:bg-gray-800 rounded mt-2 animate-pulse" />
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
          <div className="h-5 w-5 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          <div className="h-5 w-36 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
        </div>
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-6 py-4 border-b border-gray-100 dark:border-gray-800"
          >
            <div className="w-9 h-9 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
            <div className="flex-1">
              <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-3 w-40 bg-gray-200 dark:bg-gray-800 rounded mt-1 animate-pulse" />
            </div>
            <div className="h-5 w-20 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
            <div className="h-4 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
