"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

const STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "REMEDIATION", label: "Remediation" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
];

const SEVERITIES = [
  { value: "", label: "All Severities" },
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
];

const TYPES = [
  { value: "", label: "All Types" },
  { value: "FTI_EXPOSURE", label: "FTI Exposure" },
  { value: "PII_BREACH", label: "PII Breach" },
  { value: "UNAUTHORIZED_ACCESS", label: "Unauthorized Access" },
  { value: "SYSTEM_COMPROMISE", label: "System Compromise" },
  { value: "POLICY_VIOLATION", label: "Policy Violation" },
  { value: "AUTO_GENERATED", label: "Auto-Generated" },
];

export function IncidentFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentStatus = searchParams.get("status") || "";
  const currentSeverity = searchParams.get("severity") || "";
  const currentType = searchParams.get("type") || "";

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.push(`/incidents?${params.toString()}`);
    },
    [router, searchParams]
  );

  const clearFilters = useCallback(() => {
    router.push("/incidents");
  }, [router]);

  const hasFilters = currentStatus || currentSeverity || currentType;

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      <select
        value={currentStatus}
        onChange={(e) => updateFilter("status", e.target.value)}
        className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <select
        value={currentSeverity}
        onChange={(e) => updateFilter("severity", e.target.value)}
        className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {SEVERITIES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <select
        value={currentType}
        onChange={(e) => updateFilter("type", e.target.value)}
        className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      {hasFilters && (
        <button
          onClick={clearFilters}
          className="px-3 py-2 text-sm rounded-lg text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
