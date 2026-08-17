import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  User,
  Shield,
  AlertTriangle,
  CheckCircle2,
  FileText,
  MessageSquare,
  UserCheck,
  ArrowRight,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/utils";
import { IncidentDetailActions } from "@/components/incident-detail-actions";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  INVESTIGATING:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  REMEDIATION:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  RESOLVED:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  CLOSED: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  MEDIUM:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
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

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  CREATED: CheckCircle2,
  STATUS_CHANGE: ArrowRight,
  NOTE_ADDED: MessageSquare,
  REMEDIATION_UPDATED: FileText,
  ASSIGNED: UserCheck,
};

const ACTIVITY_COLORS: Record<string, string> = {
  CREATED: "bg-blue-500 text-white",
  STATUS_CHANGE: "bg-amber-500 text-white",
  NOTE_ADDED: "bg-gray-500 text-white",
  REMEDIATION_UPDATED: "bg-purple-500 text-white",
  ASSIGNED: "bg-green-500 text-white",
};

const ACTIVITY_LABELS: Record<string, string> = {
  CREATED: "created this incident",
  STATUS_CHANGE: "changed status",
  NOTE_ADDED: "added a note",
  REMEDIATION_UPDATED: "updated remediation plan",
  ASSIGNED: "was assigned",
};

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) return null;

  const { id } = await params;
  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;

  let incident;
  try {
    incident = await db.incident.findFirst({
      where: { id, organizationId: orgId },
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        activities: {
          orderBy: { createdAt: "desc" },
          include: {
            user: { select: { name: true } },
          },
        },
      },
    });
  } catch {
    // DB not available
  }

  if (!incident) {
    notFound();
  }

  const relatedSections = (incident.relatedSections as Array<{ section: string; text: string }> | null) || [];

  // Status progress steps
  const statusOrder = ["OPEN", "INVESTIGATING", "REMEDIATION", "RESOLVED", "CLOSED"];
  const currentStatusIndex = statusOrder.indexOf(incident.status);

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      {/* Breadcrumb */}
      <div className="mb-6">
        <Link
          href="/incidents"
          className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Incidents
        </Link>
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-wrap items-start gap-3 mb-3">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {incident.title}
          </h1>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${SEVERITY_STYLES[incident.severity] || ""
                }`}
            >
              {incident.severity}
            </span>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[incident.status] || ""
                }`}
            >
              {incident.status.replace("_", " ")}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-1.5">
            <Shield className="w-4 h-4" />
            {TYPE_LABELS[incident.type] || incident.type}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            Discovered{" "}
            {formatDateTime(incident.dateDiscovered || incident.createdAt)}
          </span>
          {incident.assignedTo && (
            <span className="inline-flex items-center gap-1.5">
              <User className="w-4 h-4" />
              Assigned to {incident.assignedTo.name}
            </span>
          )}
          {incident.createdBy && (
            <span className="inline-flex items-center gap-1.5">
              Created by {incident.createdBy.name}
            </span>
          )}
        </div>
      </div>

      {/* Status Progress Bar */}
      <div className="mb-6 overflow-x-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-5">
        <div className="flex min-w-[520px] items-center justify-between">
          {statusOrder.map((status, i) => {
            const isCompleted = i < currentStatusIndex;
            const isCurrent = i === currentStatusIndex;
            return (
              <div key={status} className="flex items-center flex-1 last:flex-initial">
                <div className="flex flex-col items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${isCompleted
                        ? "bg-green-500 text-white"
                        : isCurrent
                          ? "bg-blue-600 text-white ring-4 ring-blue-100 dark:ring-blue-900/30"
                          : "bg-gray-200 dark:bg-gray-800 text-gray-400"
                      }`}
                  >
                    {isCompleted ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      i + 1
                    )}
                  </div>
                  <span
                    className={`text-[10px] mt-1.5 font-medium ${isCurrent
                        ? "text-blue-600 dark:text-blue-400"
                        : isCompleted
                          ? "text-green-600 dark:text-green-400"
                          : "text-gray-400"
                      }`}
                  >
                    {status.charAt(0) + status.slice(1).toLowerCase()}
                  </span>
                </div>
                {i < statusOrder.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-2 mt-[-16px] ${i < currentStatusIndex
                        ? "bg-green-500"
                        : "bg-gray-200 dark:bg-gray-800"
                      }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Description */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
              Description
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
              {incident.description || "No description provided."}
            </p>
          </div>

          {/* Affected Systems */}
          {incident.affectedSystems && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                Affected Systems
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {incident.affectedSystems}
              </p>
            </div>
          )}

          {/* Remediation Plan */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
              Remediation Plan
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
              {incident.remediationPlan || "No remediation plan defined yet."}
            </p>
          </div>

          {/* Related Pub 1075 Sections */}
          {relatedSections.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                Related Pub 1075 Sections
              </h2>
              <div className="space-y-2">
                {relatedSections.map((item, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800"
                  >
                    <Shield className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
                        {item.section}
                      </span>
                      {item.text && (
                        <p className="text-xs text-blue-600/70 dark:text-blue-400/70 mt-0.5">
                          {item.text}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Activity Timeline */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
              Activity Timeline
            </h2>
            {incident.activities.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-gray-400">
                <Clock className="w-8 h-8 mb-2" />
                <p className="text-sm">No activity recorded yet.</p>
              </div>
            ) : (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200 dark:bg-gray-800" />

                <div className="space-y-6">
                  {incident.activities.map((activity: { id: string; action: string; details: string | null; createdAt: Date; user?: { name: string } | null }, index: number) => {
                    const Icon =
                      ACTIVITY_ICONS[activity.action] || AlertTriangle;
                    const colorClass =
                      ACTIVITY_COLORS[activity.action] ||
                      "bg-gray-500 text-white";

                    return (
                      <div key={activity.id} className="relative flex gap-4 pl-0">
                        {/* Timeline dot */}
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10 ${colorClass}`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0 pb-2">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-900 dark:text-white">
                              {activity.user?.name || "System"}
                            </span>
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              {ACTIVITY_LABELS[activity.action] ||
                                activity.action
                                  .replace(/_/g, " ")
                                  .toLowerCase()}
                            </span>
                            <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                              {formatDateTime(activity.createdAt)}
                            </span>
                          </div>
                          {activity.details && (
                            <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
                              <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">
                                {activity.details}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar - Actions */}
        <div className="space-y-6">
          <IncidentDetailActions
            incidentId={incident.id}
            currentStatus={incident.status}
            currentSeverity={incident.severity}
            remediationPlan={incident.remediationPlan || ""}
          />

          {/* Incident Metadata */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
              Details
            </h3>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">
                  Incident ID
                </dt>
                <dd className="text-sm text-gray-900 dark:text-white font-mono mt-0.5">
                  {incident.id.slice(0, 8)}...
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">
                  Created
                </dt>
                <dd className="text-sm text-gray-900 dark:text-white mt-0.5">
                  {formatDateTime(incident.createdAt)}
                </dd>
              </div>
              {incident.dateOccurred && (
                <div>
                  <dt className="text-xs text-gray-500 dark:text-gray-400">
                    Date Occurred
                  </dt>
                  <dd className="text-sm text-gray-900 dark:text-white mt-0.5">
                    {formatDateTime(incident.dateOccurred)}
                  </dd>
                </div>
              )}
              {incident.resolvedAt && (
                <div>
                  <dt className="text-xs text-gray-500 dark:text-gray-400">
                    Resolved At
                  </dt>
                  <dd className="text-sm text-gray-900 dark:text-white mt-0.5">
                    {formatDateTime(incident.resolvedAt)}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
