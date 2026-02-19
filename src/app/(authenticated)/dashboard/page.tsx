import {
  Shield,
  AlertTriangle,
  FileSpreadsheet,
  MessageSquare,
  ArrowRight,
  Activity,
  TrendingUp,
  CheckCircle2,
  Clock,
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
    recentIncidents,
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
    db.incident.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, title: true, severity: true, status: true, createdAt: true },
    }),
  ]);

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
    recentIncidents,
    totalConversations,
  };
}

const ACTION_LABELS: Record<string, string> = {
  LOGIN: "signed in",
  LOGOUT: "signed out",
  AI_QUERY: "asked AI Agent",
  INCIDENT_CREATE: "created incident",
  INCIDENT_UPDATE: "updated incident",
  SCSEM_ASSESSMENT: "assessed SCSEM",
  USER_CREATE: "invited user",
  PII_DETECTED: "PII detected",
  SETTINGS_UPDATE: "updated settings",
};

const ACTION_COLORS: Record<string, string> = {
  LOGIN: "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400",
  AI_QUERY: "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
  INCIDENT_CREATE: "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400",
  PII_DETECTED: "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400",
  SCSEM_ASSESSMENT: "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400",
};

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "text-red-500",
  HIGH: "text-orange-500",
  MEDIUM: "text-yellow-500",
  LOW: "text-blue-500",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-blue-500",
  INVESTIGATING: "bg-amber-500",
  REMEDIATION: "bg-purple-500",
  RESOLVED: "bg-green-500",
  CLOSED: "bg-gray-500",
};

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;

  let data;
  try {
    data = await getDashboardData(orgId);
  } catch {
    data = {
      complianceScore: 0,
      openIncidents: 0,
      incidentsBySeverity: {},
      scsemTotal: 58,
      scsemAssessed: 0,
      scsemInProgress: 0,
      recentLogs: [],
      recentIncidents: [],
      totalConversations: 0,
    };
  }

  const scsemNotStarted = data.scsemTotal - data.scsemAssessed - data.scsemInProgress;

  // Compute donut chart segments for SCSEM
  const scsemSegments = [
    { label: "Completed", value: data.scsemAssessed, color: "#22c55e" },
    { label: "In Progress", value: data.scsemInProgress, color: "#3b82f6" },
    { label: "Not Started", value: scsemNotStarted, color: "#374151" },
  ].filter((s) => s.value > 0);

  const scsemTotalCount = scsemSegments.reduce((s, v) => s + v.value, 0);

  // Build donut SVG pie slices
  function computeDonutPaths(segments: { value: number; color: string }[], total: number) {
    if (total === 0) return [];
    const radius = 40;
    const cx = 50;
    const cy = 50;
    let cumAngle = -90;
    return segments.map((seg) => {
      const angle = (seg.value / total) * 360;
      const startAngle = cumAngle;
      const endAngle = cumAngle + angle;
      cumAngle = endAngle;
      const startRad = (startAngle * Math.PI) / 180;
      const endRad = (endAngle * Math.PI) / 180;
      const x1 = cx + radius * Math.cos(startRad);
      const y1 = cy + radius * Math.sin(startRad);
      const x2 = cx + radius * Math.cos(endRad);
      const y2 = cy + radius * Math.sin(endRad);
      const largeArc = angle > 180 ? 1 : 0;
      return {
        d: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`,
        color: seg.color,
      };
    });
  }

  const donutPaths = computeDonutPaths(scsemSegments, scsemTotalCount);

  // Severity bar chart data
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const maxSeverityCount = Math.max(
    ...severities.map((s) => data.incidentsBySeverity[s] || 0),
    1
  );

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
          <div className="mt-3 w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2.5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${data.complianceScore}%`,
                background:
                  data.complianceScore >= 80
                    ? "#22c55e"
                    : data.complianceScore >= 50
                      ? "#eab308"
                      : "#ef4444",
              }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {data.complianceScore >= 80 ? "On track" : data.complianceScore > 0 ? "Needs attention" : "No assessments completed"}
          </p>
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
          <div className="mt-3 flex gap-2 text-xs flex-wrap">
            {data.incidentsBySeverity.CRITICAL ? (
              <span className="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-medium">
                {data.incidentsBySeverity.CRITICAL} Critical
              </span>
            ) : null}
            {data.incidentsBySeverity.HIGH ? (
              <span className="px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 font-medium">
                {data.incidentsBySeverity.HIGH} High
              </span>
            ) : null}
            {data.incidentsBySeverity.MEDIUM ? (
              <span className="px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-medium">
                {data.incidentsBySeverity.MEDIUM} Medium
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
            <span className="text-lg text-gray-400 font-normal">/{data.scsemTotal}</span>
          </div>
          <div className="mt-3 flex gap-1.5 text-xs">
            <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
              <CheckCircle2 className="w-3 h-3" /> {data.scsemAssessed} done
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
              <Clock className="w-3 h-3" /> {data.scsemInProgress} active
            </span>
          </div>
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
          <p className="text-xs text-gray-500 mt-3">Pub 1075 queries</p>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* SCSEM Assessment Donut Chart */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            SCSEM Coverage
          </h2>
          <div className="flex items-center gap-8">
            <div className="relative w-32 h-32 shrink-0">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                {scsemTotalCount === 0 ? (
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="20"
                    className="text-gray-200 dark:text-gray-800"
                  />
                ) : (
                  donutPaths.map((p, i) => (
                    <path key={i} d={p.d} fill={p.color} />
                  ))
                )}
                <circle cx="50" cy="50" r="28" className="fill-white dark:fill-gray-900" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <span className="text-xl font-bold text-gray-900 dark:text-white">
                    {scsemTotalCount > 0
                      ? Math.round((data.scsemAssessed / scsemTotalCount) * 100)
                      : 0}%
                  </span>
                </div>
              </div>
            </div>
            <div className="flex-1 space-y-3">
              {scsemSegments.map((seg) => (
                <div key={seg.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: seg.color }}
                    />
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {seg.label}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    {seg.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Incidents by Severity Bar Chart */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Incidents by Severity
          </h2>
          <div className="space-y-4">
            {severities.map((sev) => {
              const count = data.incidentsBySeverity[sev] || 0;
              const percentage = (count / maxSeverityCount) * 100;
              const barColors: Record<string, string> = {
                CRITICAL: "bg-red-500",
                HIGH: "bg-orange-500",
                MEDIUM: "bg-yellow-500",
                LOW: "bg-blue-500",
              };
              return (
                <div key={sev}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-gray-600 dark:text-gray-400 capitalize">
                      {sev.charAt(0) + sev.slice(1).toLowerCase()}
                    </span>
                    <span className={`text-sm font-bold ${SEVERITY_COLORS[sev]}`}>
                      {count}
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${barColors[sev]}`}
                      style={{ width: `${count > 0 ? Math.max(percentage, 8) : 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {Object.keys(data.incidentsBySeverity).length === 0 && (
            <div className="flex items-center justify-center py-4">
              <p className="text-sm text-gray-400">No open incidents</p>
            </div>
          )}
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
              className="flex items-center justify-between p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-all group"
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
              className="flex items-center justify-between p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-all group"
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
              className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-all group"
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

          {/* Recent Incidents Mini-List */}
          {data.recentIncidents.length > 0 && (
            <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                Latest Incidents
              </h3>
              <div className="space-y-2">
                {data.recentIncidents.slice(0, 3).map((inc) => (
                  <Link
                    key={inc.id}
                    href={`/incidents/${inc.id}`}
                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group"
                  >
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[inc.status] || "bg-gray-400"}`}
                    />
                    <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                      {inc.title}
                    </span>
                    <span
                      className={`text-[10px] font-bold ${SEVERITY_COLORS[inc.severity] || "text-gray-400"}`}
                    >
                      {inc.severity}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Recent Activity
            </h2>
            <Link
              href="/audit-log"
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              View all
            </Link>
          </div>
          {data.recentLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Activity className="w-8 h-8 mb-2" />
              <p className="text-sm">No recent activity</p>
            </div>
          ) : (
            <div className="space-y-1">
              {data.recentLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      ACTION_COLORS[log.action] || "bg-gray-100 dark:bg-gray-800 text-gray-500"
                    }`}
                  >
                    <AlertCircle className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      <span className="font-medium">{log.user?.name || "System"}</span>{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {ACTION_LABELS[log.action] || log.action.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0 tabular-nums">
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
