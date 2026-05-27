"use client";

import { useRouter, useSearchParams } from "next/navigation";

const actionTypes = [
  "LOGIN",
  "LOGOUT",
  "AI_QUERY",
  "INCIDENT_CREATE",
  "INCIDENT_UPDATE",
  "SCSEM_ASSESSMENT",
  "SCSEM_UPDATER_UPLOAD",
  "SCSEM_UPDATER_ANALYZE",
  "SCSEM_UPDATER_REVIEW",
  "SCSEM_UPDATER_EDIT",
  "SCSEM_UPDATER_UNDO",
  "SCSEM_UPDATER_EXPORT",
  "USER_CREATE",
  "USER_UPDATE",
  "USER_PASSWORD_RESET",
  "USER_MFA_RESET",
  "PII_DETECTED",
  "SETTINGS_UPDATE",
  "MFA_SETUP_STARTED",
  "MFA_SETUP_FAILED",
  "MFA_ENABLED",
  "MFA_FAILURE",
  "MFA_DISABLE_FAILED",
  "MFA_DISABLED",
  "MFA_RECOVERY_REGENERATE_FAILED",
  "MFA_RECOVERY_REGENERATED",
  "KNOWLEDGE_DOCUMENT_IMPORT",
  "KNOWLEDGE_DOCUMENT_UPDATE",
  "KNOWLEDGE_DOCUMENT_DELETE",
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
        className="px-3 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
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
