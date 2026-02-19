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
        (sum: number, a: { complianceScore: number | null }) => sum + (a.complianceScore || 0),
        0
      ) / completedAssessments.length
      : 0;

  const severityMap: Record<string, number> = {};
  incidentCounts.forEach((ic: { severity: string; _count: number }) => {
    severityMap[ic.severity] = ic._count;
  });

  const statusMap: Record<string, number> = {};
  scsemStats.forEach((s: { status: string; _count: number }) => {
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
  LOGIN: "bg-emerald-500/10 text-emerald-400",
  AI_QUERY: "bg-sky-500/10 text-sky-400",
  INCIDENT_CREATE: "bg-amber-500/10 text-amber-400",
  PII_DETECTED: "bg-red-500/10 text-red-400",
  SCSEM_ASSESSMENT: "bg-violet-500/10 text-violet-400",
};

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "text-red-400",
  HIGH: "text-orange-400",
  MEDIUM: "text-yellow-400",
  LOW: "text-sky-400",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-sky-500",
  INVESTIGATING: "bg-amber-500",
  REMEDIATION: "bg-violet-500",
  RESOLVED: "bg-emerald-500",
  CLOSED: "bg-slate-500",
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
    { label: "In Progress", value: data.scsemInProgress, color: "#2196F3" },
    { label: "Not Started", value: scsemNotStarted, color: "#1A2E45" },
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
      <div className="mb-8 animate-in">
        <h1 className="text-2xl font-bold text-white">
          Dashboard
        </h1>
        <p className="mt-1" style={{ color: 'var(--sky-text-secondary)' }}>
          Publication 1075 compliance overview
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {/* Compliance Score */}
        <div className="glass-card rounded-xl p-6 slide-up stagger-1">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--sky-text-secondary)' }}>
              Compliance Score
            </span>
            <TrendingUp className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="text-3xl font-bold text-white">
            {data.complianceScore}%
          </div>
          <div className="mt-3 w-full rounded-full h-2.5 overflow-hidden" style={{ background: 'var(--sky-surface-overlay)' }}>
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
          <p className="text-xs mt-2" style={{ color: 'var(--sky-text-muted)' }}>
            {data.complianceScore >= 80 ? "On track" : data.complianceScore > 0 ? "Needs attention" : "No assessments completed"}
          </p>
        </div>

        {/* Open Incidents */}
        <div className="glass-card rounded-xl p-6 slide-up stagger-2">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--sky-text-secondary)' }}>
              Open Incidents
            </span>
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          <div className="text-3xl font-bold text-white">
            {data.openIncidents}
          </div>
          <div className="mt-3 flex gap-2 text-xs flex-wrap">
            {data.incidentsBySeverity.CRITICAL ? (
              <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-medium">
                {data.incidentsBySeverity.CRITICAL} Critical
              </span>
            ) : null}
            {data.incidentsBySeverity.HIGH ? (
              <span className="px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 font-medium">
                {data.incidentsBySeverity.HIGH} High
              </span>
            ) : null}
            {data.incidentsBySeverity.MEDIUM ? (
              <span className="px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-medium">
                {data.incidentsBySeverity.MEDIUM} Medium
              </span>
            ) : null}
          </div>
        </div>

        {/* SCSEM Status */}
        <div className="glass-card rounded-xl p-6 slide-up stagger-3">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--sky-text-secondary)' }}>
              SCSEM Assessments
            </span>
            <FileSpreadsheet className="w-5 h-5" style={{ color: 'var(--sky-blue)' }} />
          </div>
          <div className="text-3xl font-bold text-white">
            {data.scsemAssessed}
            <span className="text-lg font-normal" style={{ color: 'var(--sky-text-muted)' }}>/{data.scsemTotal}</span>
          </div>
          <div className="mt-3 flex gap-1.5 text-xs">
            <span className="flex items-center gap-1 text-emerald-400">
              <CheckCircle2 className="w-3 h-3" /> {data.scsemAssessed} done
            </span>
            <span style={{ color: 'var(--sky-border-bright)' }}>|</span>
            <span className="flex items-center gap-1" style={{ color: 'var(--sky-light)' }}>
              <Clock className="w-3 h-3" /> {data.scsemInProgress} active
            </span>
          </div>
        </div>

        {/* AI Conversations */}
        <div className="glass-card rounded-xl p-6 slide-up stagger-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--sky-text-secondary)' }}>
              AI Conversations
            </span>
            <MessageSquare className="w-5 h-5 text-violet-400" />
          </div>
          <div className="text-3xl font-bold text-white">
            {data.totalConversations}
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--sky-text-muted)' }}>Pub 1075 queries</p>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* SCSEM Assessment Donut Chart */}
        <div className="glass-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
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
                    stroke="var(--sky-surface-overlay)"
                    strokeWidth="20"
                  />
                ) : (
                  donutPaths.map((p, i) => (
                    <path key={i} d={p.d} fill={p.color} />
                  ))
                )}
                <circle cx="50" cy="50" r="28" fill="var(--sky-surface)" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <span className="text-xl font-bold text-white">
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
                    <span className="text-sm" style={{ color: 'var(--sky-text-secondary)' }}>
                      {seg.label}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-white">
                    {seg.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Incidents by Severity Bar Chart */}
        <div className="glass-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
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
                LOW: "bg-sky-500",
              };
              return (
                <div key={sev}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm capitalize" style={{ color: 'var(--sky-text-secondary)' }}>
                      {sev.charAt(0) + sev.slice(1).toLowerCase()}
                    </span>
                    <span className={`text-sm font-bold ${SEVERITY_COLORS[sev]}`}>
                      {count}
                    </span>
                  </div>
                  <div className="w-full rounded-full h-2.5 overflow-hidden" style={{ background: 'var(--sky-surface-overlay)' }}>
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
              <p className="text-sm" style={{ color: 'var(--sky-text-muted)' }}>No open incidents</p>
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Actions */}
        <div className="glass-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            Quick Actions
          </h2>
          <div className="space-y-3">
            <Link
              href="/agent"
              className="flex items-center justify-between p-3 rounded-xl transition-all group hover:glow-sm"
              style={{ background: 'rgba(33, 150, 243, 0.08)', border: '1px solid rgba(33, 150, 243, 0.15)' }}
            >
              <div className="flex items-center gap-3">
                <MessageSquare className="w-5 h-5" style={{ color: 'var(--sky-light)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--sky-light)' }}>
                  Ask AI Agent
                </span>
              </div>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" style={{ color: 'var(--sky-light)' }} />
            </Link>

            <Link
              href="/incidents?new=true"
              className="flex items-center justify-between p-3 rounded-xl transition-all group"
              style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.15)' }}
            >
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                <span className="text-sm font-medium text-amber-300">
                  Report Incident
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-amber-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>

            <Link
              href="/scsems"
              className="flex items-center justify-between p-3 rounded-xl transition-all group"
              style={{ background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.15)' }}
            >
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-300">
                  Start SCSEM Assessment
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-emerald-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>

          {/* Recent Incidents Mini-List */}
          {data.recentIncidents.length > 0 && (
            <div className="mt-6 pt-5" style={{ borderTop: '1px solid var(--sky-border)' }}>
              <h3 className="text-sm font-semibold text-white mb-3">
                Latest Incidents
              </h3>
              <div className="space-y-2">
                {data.recentIncidents.slice(0, 3).map((inc: { id: string; title: string; severity: string; status: string }) => (
                  <Link
                    key={inc.id}
                    href={`/incidents/${inc.id}`}
                    className="flex items-center gap-2 p-2 rounded-lg transition-colors group"
                    style={{ ['--hover-bg' as string]: 'var(--sky-surface-overlay)' }}
                  >
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[inc.status] || "bg-slate-400"}`}
                    />
                    <span className="text-xs truncate flex-1 transition-colors" style={{ color: 'var(--sky-text-secondary)' }}>
                      {inc.title}
                    </span>
                    <span
                      className={`text-[10px] font-bold ${SEVERITY_COLORS[inc.severity] || "text-slate-400"}`}
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
        <div className="lg:col-span-2 glass-card rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Recent Activity
            </h2>
            <Link
              href="/audit-log"
              className="text-xs hover:underline" style={{ color: 'var(--sky-light)' }}
            >
              View all
            </Link>
          </div>
          {data.recentLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12" style={{ color: 'var(--sky-text-muted)' }}>
              <Activity className="w-8 h-8 mb-2" />
              <p className="text-sm">No recent activity</p>
            </div>
          ) : (
            <div className="space-y-1">
              {data.recentLogs.map((log: { id: string; action: string; user?: { name: string } | null; createdAt: Date }) => (
                <div
                  key={log.id}
                  className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-white/[0.03]"
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${ACTION_COLORS[log.action] || "bg-slate-500/10 text-slate-400"
                      }`}
                  >
                    <AlertCircle className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">
                      <span className="font-medium text-white">{log.user?.name || "System"}</span>{" "}
                      <span style={{ color: 'var(--sky-text-secondary)' }}>
                        {ACTION_LABELS[log.action] || log.action.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </p>
                  </div>
                  <span className="text-xs shrink-0 tabular-nums" style={{ color: 'var(--sky-text-muted)' }}>
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
