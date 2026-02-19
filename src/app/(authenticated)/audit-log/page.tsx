import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/utils";
import {
  ScrollText,
  User,
  Shield,
  AlertTriangle,
  FileSpreadsheet,
  Settings,
  MessageSquare,
  LogIn,
} from "lucide-react";
import { AuditLogFilters } from "@/components/audit-log-filters";

const actionIcons: Record<string, React.ElementType> = {
  LOGIN: LogIn,
  LOGOUT: LogIn,
  AI_QUERY: MessageSquare,
  INCIDENT_CREATE: AlertTriangle,
  INCIDENT_UPDATE: AlertTriangle,
  SCSEM_ASSESSMENT: FileSpreadsheet,
  USER_CREATE: User,
  USER_UPDATE: User,
  PII_DETECTED: Shield,
  SETTINGS_UPDATE: Settings,
};

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; user?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;
  const params = await searchParams;
  const page = parseInt(params.page || "1");
  const pageSize = 50;

  let logs: Array<{
    id: string;
    action: string;
    resourceType: string | null;
    resourceId: string | null;
    metadata: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    user: { name: string } | null;
  }> = [];
  let total = 0;

  try {
    const where: Record<string, unknown> = { organizationId: orgId };
    if (params.action) where.action = params.action;
    if (params.user) where.userId = params.user;

    [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { name: true } } },
      }),
      db.auditLog.count({ where }),
    ]);
  } catch {
    // DB not available
  }

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Audit Log
          </h1>
          <p className="text-[var(--sky-text-secondary)] mt-1">
            All system activity is logged and non-deletable
          </p>
        </div>
        <div className="text-sm text-gray-500">
          {total} total entries
        </div>
      </div>

      <AuditLogFilters />

      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--sky-border)]">
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                  Timestamp
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                  User
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                  Action
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                  Resource
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                  IP Address
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--sky-border)]">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <ScrollText className="w-8 h-8 text-gray-300 text-[var(--sky-text-muted)] mx-auto mb-2" />
                    <p className="text-sm text-gray-500">No audit logs found</p>
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const Icon = actionIcons[log.action] || ScrollText;
                  return (
                    <tr
                      key={log.id}
                      className="hover:bg-white/[0.03] transition-colors"
                    >
                      <td className="px-4 py-3 text-sm text-[var(--sky-text-secondary)] whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--sky-text-primary)] whitespace-nowrap">
                        {log.user?.name || "System"}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-[var(--sky-text-primary)]">
                            {log.action.replace(/_/g, " ")}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--sky-text-secondary)] whitespace-nowrap">
                        {log.resourceType && (
                          <span>
                            {log.resourceType}
                            {log.resourceId
                              ? ` #${log.resourceId.slice(0, 8)}`
                              : ""}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--sky-text-secondary)] font-mono whitespace-nowrap">
                        {log.ipAddress || "â€”"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--sky-border)]">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              {page > 1 && (
                <a
                  href={`/audit-log?page=${page - 1}${params.action ? `&action=${params.action}` : ""}`}
                  className="px-3 py-1.5 text-sm bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg hover:bg-[var(--sky-surface-overlay)] text-[var(--sky-text-secondary)]"
                >
                  Previous
                </a>
              )}
              {page < totalPages && (
                <a
                  href={`/audit-log?page=${page + 1}${params.action ? `&action=${params.action}` : ""}`}
                  className="px-3 py-1.5 text-sm bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] rounded-lg hover:bg-[var(--sky-surface-overlay)] text-[var(--sky-text-secondary)]"
                >
                  Next
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

