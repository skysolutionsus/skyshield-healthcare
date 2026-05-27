import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AuditLogFilters } from "@/components/audit-log-filters";
import { AuditLogTable, type AuditLogEntry } from "@/components/audit-log-table";

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
    user: { name: string; email: string } | null;
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
        include: { user: { select: { name: true, email: true } } },
      }),
      db.auditLog.count({ where }),
    ]);
  } catch {
    // DB not available
  }

  const totalPages = Math.ceil(total / pageSize);
  const clientLogs: AuditLogEntry[] = logs.map((log) => ({
    ...log,
    createdAt: log.createdAt.toISOString(),
  }));

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
        <AuditLogTable logs={clientLogs} />

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
