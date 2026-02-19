import { AlertTriangle, Plus, Search } from "lucide-react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { IncidentFilters } from "@/components/incident-filters";
import { NewIncidentDialog } from "@/components/new-incident-dialog";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  INVESTIGATING: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  REMEDIATION: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  RESOLVED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  CLOSED: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  MEDIUM: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  LOW: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
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
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Incident Tracker
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Track and manage security incidents and compliance violations
          </p>
        </div>
        <NewIncidentDialog />
      </div>

      {/* Filters */}
      <IncidentFilters />

      {/* Incidents Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        {incidents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <AlertTriangle className="w-10 h-10 mb-3" />
            <p className="text-lg font-medium text-gray-500 dark:text-gray-400">
              No incidents found
            </p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              {params.status || params.severity || params.type
                ? "Try adjusting your filters"
                : "No incidents have been reported yet"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800">
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Title
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Severity
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Assigned To
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {incidents.map((incident) => (
                  <tr
                    key={incident.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <Link
                        href={`/incidents/${incident.id}`}
                        className="text-sm font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      >
                        {incident.title}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
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
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {incident.assignedTo?.name || "Unassigned"}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {formatDate(incident.dateDiscovered || incident.createdAt)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
