"use client";

import { useRouter, useSearchParams } from "next/navigation";

const actionTypes = [
  "LOGIN",
  "LOGOUT",
  "AI_QUERY",
  "INCIDENT_CREATE",
  "INCIDENT_UPDATE",
  "SCSEM_ASSESSMENT",
  "USER_CREATE",
  "USER_UPDATE",
  "PII_DETECTED",
  "SETTINGS_UPDATE",
];

export function AuditLogFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentAction = searchParams.get("action") || "";

  function handleActionChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("action", value);
    } else {
      params.delete("action");
    }
    params.delete("page");
    router.push(`/audit-log?${params.toString()}`);
  }

  return (
    <div className="flex gap-3 mb-6">
      <select
        value={currentAction}
        onChange={(e) => handleActionChange(e.target.value)}
        className="px-3 py-2 bg-white bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-[var(--sky-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
      >
        <option value="">All Actions</option>
        {actionTypes.map((action) => (
          <option key={action} value={action}>
            {action.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </div>
  );
}

