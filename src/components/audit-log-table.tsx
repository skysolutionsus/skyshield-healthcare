"use client";

import { useMemo, useState } from "react";
import type { ElementType } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Database,
  Download,
  FileSpreadsheet,
  LogIn,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Settings,
  Shield,
  Upload,
  User,
  X,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

export interface AuditLogEntry {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user: { name: string; email?: string | null } | null;
}

const actionIcons: Record<string, ElementType> = {
  LOGIN: LogIn,
  LOGOUT: LogIn,
  AI_QUERY: MessageSquare,
  INCIDENT_CREATE: AlertTriangle,
  INCIDENT_UPDATE: AlertTriangle,
  SCSEM_ASSESSMENT: FileSpreadsheet,
  SCSEM_UPDATER_UPLOAD: Upload,
  SCSEM_UPDATER_ANALYZE: FileSpreadsheet,
  SCSEM_UPDATER_REVIEW: Shield,
  SCSEM_UPDATER_EDIT: FileSpreadsheet,
  SCSEM_UPDATER_UNDO: RotateCcw,
  SCSEM_UPDATER_EXPORT: Download,
  USER_CREATE: User,
  USER_UPDATE: User,
  USER_PASSWORD_RESET: User,
  USER_MFA_RESET: Shield,
  PII_DETECTED: Shield,
  SETTINGS_UPDATE: Settings,
  MFA_SETUP_STARTED: Shield,
  MFA_SETUP_FAILED: Shield,
  MFA_ENABLED: Shield,
  MFA_FAILURE: Shield,
  MFA_DISABLE_FAILED: Shield,
  MFA_DISABLED: Shield,
  MFA_RECOVERY_REGENERATE_FAILED: Shield,
  MFA_RECOVERY_REGENERATED: Shield,
  KNOWLEDGE_DOCUMENT_IMPORT: Database,
  KNOWLEDGE_DOCUMENT_UPDATE: Database,
  KNOWLEDGE_DOCUMENT_DELETE: Database,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function actionLabel(action: string): string {
  return action.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function resourceLabel(log: AuditLogEntry): string {
  if (!log.resourceType) return "System";
  return `${log.resourceType.replace(/_/g, " ")}${log.resourceId ? ` #${log.resourceId.slice(0, 8)}` : ""}`;
}

function summarizeMetadata(metadata: unknown): string {
  if (!isRecord(metadata)) return "Open for details";
  const input = isRecord(metadata.input) ? metadata.input : null;
  const output = isRecord(metadata.output) ? metadata.output : null;

  const summary =
    (typeof output?.summary === "string" && output.summary) ||
    (typeof input?.fileName === "string" && input.fileName) ||
    (typeof input?.message === "string" && input.message) ||
    (typeof output?.response === "string" && output.response) ||
    "";

  if (!summary) return "Open for details";
  return summary.length > 150 ? `${summary.slice(0, 150)}...` : summary;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  const text = formatScalar(value);
  const long = text.length > 160 || text.includes("\n");

  return (
    <div className="border-t border-[var(--sky-border)] py-3 first:border-t-0">
      <dt className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">
        {label.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}
      </dt>
      <dd className={`mt-1 text-sm text-[var(--sky-text-primary)] ${long ? "whitespace-pre-wrap break-words" : "break-words"}`}>
        {text}
      </dd>
    </div>
  );
}

function DetailSection({ title, value }: { title: string; value: unknown }) {
  if (!isRecord(value)) {
    return (
      <section className="border-t border-[var(--sky-border)] pt-5">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--sky-text-secondary)]">
          {formatScalar(value)}
        </p>
      </section>
    );
  }

  return (
    <section className="border-t border-[var(--sky-border)] pt-5">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <dl className="mt-3">
        {Object.entries(value).map(([key, nestedValue]) => (
          <DetailField key={key} label={key} value={nestedValue} />
        ))}
      </dl>
    </section>
  );
}

function AuditDetailDrawer({ log, onClose }: { log: AuditLogEntry; onClose: () => void }) {
  const Icon = actionIcons[log.action] || ScrollText;
  const metadata = isRecord(log.metadata) ? log.metadata : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
      <button aria-label="Close audit details" className="absolute inset-0 cursor-default" onClick={onClose} />
      <aside className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-[var(--sky-border)] bg-[var(--sky-surface)] shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-[var(--sky-border)] bg-[var(--sky-surface)] px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)]">
                <Icon className="h-5 w-5 text-[var(--sky-light)]" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">{actionLabel(log.action)}</h2>
                <p className="mt-1 text-sm text-[var(--sky-text-secondary)]">{formatDateTime(log.createdAt)}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg border border-[var(--sky-border)] p-2 text-[var(--sky-text-secondary)] transition hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-5">
          <section>
            <h3 className="text-sm font-semibold text-white">Overview</h3>
            <dl className="mt-3">
              <DetailField label="User" value={log.user?.email ? `${log.user.name} (${log.user.email})` : log.user?.name || "System"} />
              <DetailField label="Resource" value={resourceLabel(log)} />
              <DetailField label="IP Address" value={log.ipAddress || "Not captured"} />
              <DetailField label="User Agent" value={log.userAgent || "Not captured"} />
            </dl>
          </section>

          {metadata?.input !== undefined && <DetailSection title="Input" value={metadata.input} />}
          {metadata?.output !== undefined && <DetailSection title="Output" value={metadata.output} />}
          {metadata?.retrieval !== undefined && <DetailSection title="Retrieval" value={metadata.retrieval} />}

          {metadata && (
            <section className="border-t border-[var(--sky-border)] pt-5">
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-white">Raw Metadata</summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-[var(--sky-border)] bg-black/20 p-4 text-xs leading-5 text-[var(--sky-text-secondary)]">
                  {JSON.stringify(metadata, null, 2)}
                </pre>
              </details>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

export function AuditLogTable({ logs }: { logs: AuditLogEntry[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedLog = useMemo(
    () => logs.find((log) => log.id === selectedId) || null,
    [logs, selectedId]
  );

  if (logs.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <ScrollText className="mx-auto mb-2 h-8 w-8 text-[var(--sky-text-muted)]" />
        <p className="text-sm text-gray-500">No audit logs found</p>
      </div>
    );
  }

  return (
    <>
      <div className="divide-y divide-[var(--sky-border)] md:hidden">
        {logs.map((log) => {
          const Icon = actionIcons[log.action] || ScrollText;
          return (
            <button
              key={log.id}
              type="button"
              onClick={() => setSelectedId(log.id)}
              className="block w-full space-y-3 p-4 text-left transition-colors hover:bg-white/[0.04] focus:bg-white/[0.04] focus:outline-none"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-gray-400" />
                  <span className="truncate text-sm font-medium text-[var(--sky-text-primary)]">
                    {actionLabel(log.action)}
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--sky-text-muted)]" />
              </div>
              <p className="line-clamp-2 text-sm text-[var(--sky-text-secondary)]">
                {summarizeMetadata(log.metadata)}
              </p>
              <div className="flex flex-col gap-1 text-xs text-[var(--sky-text-muted)] sm:flex-row sm:justify-between">
                <span>{log.user?.name || "System"} · {resourceLabel(log)}</span>
                <span>{formatDateTime(log.createdAt)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--sky-border)]">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--sky-text-secondary)]">Timestamp</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--sky-text-secondary)]">User</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--sky-text-secondary)]">Action</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--sky-text-secondary)]">Resource</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--sky-text-secondary)]">Details</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--sky-text-secondary)]">Open</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--sky-border)]">
            {logs.map((log) => {
              const Icon = actionIcons[log.action] || ScrollText;
              return (
                <tr
                  key={log.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(log.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelectedId(log.id);
                  }}
                  className="cursor-pointer transition-colors hover:bg-white/[0.04] focus:bg-white/[0.04] focus:outline-none"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--sky-text-secondary)]">
                    {formatDateTime(log.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--sky-text-primary)]">
                    {log.user?.name || "System"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-gray-400" />
                      <span className="text-sm text-[var(--sky-text-primary)]">{actionLabel(log.action)}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[var(--sky-text-secondary)]">
                    {resourceLabel(log)}
                  </td>
                  <td className="max-w-md px-4 py-3 text-sm text-[var(--sky-text-secondary)]">
                    <span className="line-clamp-2">{summarizeMetadata(log.metadata)}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="ml-auto h-4 w-4 text-[var(--sky-text-muted)]" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedLog && (
        <AuditDetailDrawer log={selectedLog} onClose={() => setSelectedId(null)} />
      )}
    </>
  );
}
