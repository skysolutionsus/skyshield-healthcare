import { AlertTriangle, Plus, Search } from "lucide-react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { IncidentFilters } from "@/components/incident-filters";
import { NewIncidentDialog } from "@/components/new-incident-dialog";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-sky-500/15 text-sky-400",
  INVESTIGATING: "bg-amber-500/15 text-amber-400",
  REMEDIATION: "bg-violet-500/15 text-violet-400",
  RESOLVED: "bg-emerald-500/15 text-emerald-400",
  CLOSED: "bg-[var(--sky-surface-overlay)] text-gray-700 bg-[var(--sky-surface-overlay)] text-[var(--sky-text-secondary)]",
};

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-500/15 text-red-400",
  HIGH: "bg-orange-500/15 text-orange-400",
  MEDIUM: "bg-yellow-500/15 text-yellow-400",
  LOW: "bg-sky-500/15 text-sky-400",
};

const TYPE_LABELS: Record<string, string> = {
  FTI_EXPOSURE: "FTI Exposure",
  PII_BREACH: "PII Breach",
  UNAUTHORIZED_ACCESS: "Unauthorized Access",
  SYSTEM_COMPROMISE: "System Compromise",
  POLICY_VIOLATION: "Policy Violation",
  AUTO_GENERATED: "Auto-Generated",
};

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string; type?: string }>;
}) {
  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;

  const params = await searchParams;

  // Build the Prisma where clause from search params
  const where: Record<string, unknown> = { organizationId: orgId };
  if (params.status) where.status = params.status;
  if (params.severity) where.severity = params.severity;
  if (params.type) where.type = params.type;

  let incidents: Array<{
    id: string;
    title: string;
    type: string;
    severity: string;
    status: string;
    dateDiscovered: Date;
    createdAt: Date;
    assignedTo: { name: string | null } | null;
  }> = [];

  try {
    incidents = await db.incident.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        type: true,
        severity: true,
        status: true,
        dateDiscovered: true,
        createdAt: true,
        assignedTo: { select: { name: true } },
      },
    });
  } catch {
    // DB not available
  }

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col items-start gap-4 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Incident Tracker
          </h1>
          <p className="text-[var(--sky-text-secondary)] mt-1">
            Track and manage security incidents and compliance violations
          </p>
        </div>
        <NewIncidentDialog />
      </div>

      {/* Filters */}
      <IncidentFilters />

      {/* Incidents Table */}
      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden">
        {incidents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <AlertTriangle className="w-10 h-10 mb-3" />
            <p className="text-lg font-medium text-[var(--sky-text-secondary)]">
              No incidents found
            </p>
            <p className="text-sm text-[var(--sky-text-muted)] mt-1">
              {params.status || params.severity || params.type
                ? "Try adjusting your filters"
                : "No incidents have been reported yet"}
            </p>
          </div>
        ) : (
          <>
          <div className="divide-y divide-[var(--sky-border)] md:hidden">
            {incidents.map((incident) => (
              <Link
                key={incident.id}
                href={`/incidents/${incident.id}`}
                className="block space-y-3 p-4 transition-colors hover:bg-white/[0.03]"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 break-words text-sm font-semibold text-white">
                    {incident.title}
                  </h2>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[incident.severity] || ""}`}
                  >
                    {incident.severity}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[incident.status] || ""}`}>
                    {incident.status.replace("_", " ")}
                  </span>
                  <span className="text-xs text-[var(--sky-text-secondary)]">
                    {TYPE_LABELS[incident.type] || incident.type}
                  </span>
                </div>
                <div className="flex flex-col gap-1 text-xs text-[var(--sky-text-muted)] sm:flex-row sm:justify-between">
                  <span>{incident.assignedTo?.name || "Unassigned"}</span>
                  <span>{formatDate(incident.dateDiscovered || incident.createdAt)}</span>
                </div>
              </Link>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--sky-border)]">
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                    Title
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                    Type
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                    Severity
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                    Assigned To
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--sky-text-secondary)] uppercase tracking-wider">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--sky-border)]">
                {incidents.map((incident) => (
                  <tr
                    key={incident.id}
                    className="hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="py-3 px-4">
                      <Link
                        href={`/incidents/${incident.id}`}
                        className="text-sm font-medium text-white hover:text-[var(--sky-light)] transition-colors"
                      >
                        {incident.title}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs font-medium text-[var(--sky-text-secondary)]">
                        {TYPE_LABELS[incident.type] || incident.type}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          SEVERITY_STYLES[incident.severity] || ""
                        }`}
                      >
                        {incident.severity}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          STATUS_STYLES[incident.status] || ""
                        }`}
                      >
                        {incident.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-sm text-[var(--sky-text-secondary)]">
                        {incident.assignedTo?.name || "Unassigned"}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-sm text-[var(--sky-text-secondary)]">
                        {formatDate(incident.dateDiscovered || incident.createdAt)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}

