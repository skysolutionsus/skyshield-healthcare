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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Audit Log
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            All system activity is logged and non-deletable
          </p>
        </div>
        <div className="text-sm text-gray-500">
          {total} total entries
        </div>
      </div>

      <AuditLogFilters />

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Timestamp
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  User
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Action
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Resource
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  IP Address
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <ScrollText className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">No audit logs found</p>
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const Icon = actionIcons[log.action] || ScrollText;
                  return (
                    <tr
                      key={log.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                    >
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {log.user?.name || "System"}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-900 dark:text-gray-100">
                            {log.action.replace(/_/g, " ")}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {log.resourceType && (
                          <span>
                            {log.resourceType}
                            {log.resourceId
                              ? ` #${log.resourceId.slice(0, 8)}`
                              : ""}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono whitespace-nowrap">
                        {log.ipAddress || "—"}
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
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              {page > 1 && (
                <a
                  href={`/audit-log?page=${page - 1}${params.action ? `&action=${params.action}` : ""}`}
                  className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                >
                  Previous
                </a>
              )}
              {page < totalPages && (
                <a
                  href={`/audit-log?page=${page + 1}${params.action ? `&action=${params.action}` : ""}`}
                  className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
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
