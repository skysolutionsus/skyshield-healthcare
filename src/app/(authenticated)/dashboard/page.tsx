import {
  Shield,
  AlertTriangle,
  FileSpreadsheet,
  MessageSquare,
  ArrowRight,
  Activity,
  TrendingUp,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";

async function getDashboardData(organizationId: string) {
  const [
    incidentCounts,
    totalIncidents,
    scsemStats,
    recentLogs,
    totalConversations,
  ] = await Promise.all([
    db.incident.groupBy({
      by: ["severity"],
      where: { organizationId, status: { not: "CLOSED" } },
      _count: true,
    }),
    db.incident.count({
      where: { organizationId, status: { not: "CLOSED" } },
    }),
    db.sCSEMAssessment.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: true,
    }),
    db.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { user: { select: { name: true } } },
    }),
    db.conversation.count({
      where: { user: { organizationId } },
    }),
  ]);

  // Calculate compliance score from assessments
  const completedAssessments = await db.sCSEMAssessment.findMany({
    where: { organizationId, status: "COMPLETED" },
    select: { complianceScore: true },
  });

  const avgCompliance =
    completedAssessments.length > 0
      ? completedAssessments.reduce(
          (sum, a) => sum + (a.complianceScore || 0),
          0
        ) / completedAssessments.length
      : 0;

  const severityMap: Record<string, number> = {};
  incidentCounts.forEach((ic) => {
    severityMap[ic.severity] = ic._count;
  });

  const statusMap: Record<string, number> = {};
  scsemStats.forEach((s) => {
    statusMap[s.status] = s._count;
  });

  const totalScsems = await db.sCSEMTemplate.count();

  return {
    complianceScore: Math.round(avgCompliance),
    openIncidents: totalIncidents,
    incidentsBySeverity: severityMap,
    scsemTotal: totalScsems,
    scsemAssessed: statusMap["COMPLETED"] || 0,
    scsemInProgress: statusMap["IN_PROGRESS"] || 0,
    recentLogs,
    totalConversations,
  };
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;

  let data;
  try {
    data = await getDashboardData(orgId);
  } catch {
    // DB not available, show placeholder
    data = {
      complianceScore: 0,
      openIncidents: 0,
      incidentsBySeverity: {},
      scsemTotal: 58,
      scsemAssessed: 0,
      scsemInProgress: 0,
      recentLogs: [],
      totalConversations: 0,
    };
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Dashboard
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          Publication 1075 compliance overview
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {/* Compliance Score */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Compliance Score
            </span>
            <TrendingUp className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {data.complianceScore}%
          </div>
          <div className="mt-2 w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2">
            <div
              className="bg-green-500 h-2 rounded-full transition-all"
              style={{ width: `${data.complianceScore}%` }}
            />
          </div>
        </div>

        {/* Open Incidents */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Open Incidents
            </span>
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {data.openIncidents}
          </div>
          <div className="mt-2 flex gap-2 text-xs">
            {data.incidentsBySeverity.CRITICAL ? (
              <span className="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                {data.incidentsBySeverity.CRITICAL} Critical
              </span>
            ) : null}
            {data.incidentsBySeverity.HIGH ? (
              <span className="px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400">
                {data.incidentsBySeverity.HIGH} High
              </span>
            ) : null}
          </div>
        </div>

        {/* SCSEM Status */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
              SCSEM Assessments
            </span>
            <FileSpreadsheet className="w-5 h-5 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {data.scsemAssessed}
            <span className="text-lg text-gray-400">/{data.scsemTotal}</span>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {data.scsemInProgress} in progress
          </p>
        </div>

        {/* AI Conversations */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
              AI Conversations
            </span>
            <MessageSquare className="w-5 h-5 text-purple-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {data.totalConversations}
          </div>
          <p className="text-xs text-gray-500 mt-2">Pub 1075 queries</p>
        </div>
      </div>

      {/* Quick Actions + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Actions */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Quick Actions
          </h2>
          <div className="space-y-3">
            <Link
              href="/agent"
              className="flex items-center justify-between p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <MessageSquare className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-medium text-blue-900 dark:text-blue-300">
                  Ask AI Agent
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-blue-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>

            <Link
              href="/incidents?new=true"
              className="flex items-center justify-between p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-medium text-amber-900 dark:text-amber-300">
                  Report Incident
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-amber-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>

            <Link
              href="/scsems"
              className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="w-5 h-5 text-green-600 dark:text-green-400" />
                <span className="text-sm font-medium text-green-900 dark:text-green-300">
                  Start SCSEM Assessment
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-green-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Recent Activity
          </h2>
          {data.recentLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <Activity className="w-8 h-8 mb-2" />
              <p className="text-sm">No recent activity</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.recentLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 mt-0.5">
                    <AlertCircle className="w-4 h-4 text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      <span className="font-medium">{log.user?.name}</span>{" "}
                      {log.action}
                    </p>
                    {log.resourceType && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {log.resourceType}
                        {log.resourceId ? ` #${log.resourceId.slice(0, 8)}` : ""}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">
                    {formatDateTime(log.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
