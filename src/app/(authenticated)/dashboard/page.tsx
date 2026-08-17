import {
  Shield,
  AlertTriangle,
  FileSpreadsheet,
  MessageSquare,
  ArrowRight,
  Activity,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { officialSCSEMManifest } from "@/lib/scsem-official-manifest";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { formatDateTime } from "@/lib/utils";

async function getDashboardData(organizationId: string) {
  const [
    incidentCounts,
    totalIncidents,
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

  const severityMap: Record<string, number> = {};
  incidentCounts.forEach((ic: { severity: string; _count: number }) => {
    severityMap[ic.severity] = ic._count;
  });

  return {
    openIncidents: totalIncidents,
    incidentsBySeverity: severityMap,
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
  USER_CREATE: "invited user",
  USER_PASSWORD_RESET: "reset password",
  USER_MFA_RESET: "reset MFA",
  PII_DETECTED: "PII detected",
  SETTINGS_UPDATE: "updated settings",
  MFA_SETUP_STARTED: "started MFA setup",
  MFA_SETUP_FAILED: "failed MFA setup",
  MFA_ENABLED: "enabled MFA",
  MFA_FAILURE: "failed MFA",
  MFA_DISABLE_FAILED: "failed MFA disable",
  MFA_DISABLED: "disabled MFA",
  MFA_RECOVERY_REGENERATE_FAILED: "failed recovery code rotation",
  MFA_RECOVERY_REGENERATED: "rotated recovery codes",
  KNOWLEDGE_DOCUMENT_IMPORT: "imported knowledge",
  KNOWLEDGE_DOCUMENT_UPDATE: "updated knowledge",
  KNOWLEDGE_DOCUMENT_DELETE: "deleted knowledge",
};

const ACTION_COLORS: Record<string, string> = {
  LOGIN: "bg-emerald-500/10 text-emerald-400",
  AI_QUERY: "bg-sky-500/10 text-sky-400",
  INCIDENT_CREATE: "bg-amber-500/10 text-amber-400",
  USER_PASSWORD_RESET: "bg-amber-500/10 text-amber-300",
  USER_MFA_RESET: "bg-cyan-500/10 text-cyan-300",
  PII_DETECTED: "bg-red-500/10 text-red-400",
  MFA_SETUP_STARTED: "bg-cyan-500/10 text-cyan-300",
  MFA_SETUP_FAILED: "bg-red-500/10 text-red-300",
  MFA_ENABLED: "bg-emerald-500/10 text-emerald-300",
  MFA_FAILURE: "bg-red-500/10 text-red-300",
  MFA_DISABLE_FAILED: "bg-red-500/10 text-red-300",
  MFA_DISABLED: "bg-amber-500/10 text-amber-300",
  MFA_RECOVERY_REGENERATE_FAILED: "bg-red-500/10 text-red-300",
  MFA_RECOVERY_REGENERATED: "bg-cyan-500/10 text-cyan-300",
  KNOWLEDGE_DOCUMENT_IMPORT: "bg-indigo-500/10 text-indigo-300",
  KNOWLEDGE_DOCUMENT_UPDATE: "bg-indigo-500/10 text-indigo-300",
  KNOWLEDGE_DOCUMENT_DELETE: "bg-red-500/10 text-red-300",
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
  const scsemAccess = await requireScsemSteward();
  const canManageCanonicalScsems = scsemAccess.ok;
  const scsemManifest = officialSCSEMManifest();
  const scsemSourcePolicy = scsemManifest.sourcePolicy === "individual_xlsx_links"
    ? "Individual IRS XLSX links"
    : scsemManifest.sourcePolicy;

  let data;
  try {
    data = await getDashboardData(orgId);
  } catch {
    data = {
      openIncidents: 0,
      incidentsBySeverity: {},
      recentLogs: [],
      recentIncidents: [],
      totalConversations: 0,
    };
  }

  // Severity bar chart data
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const maxSeverityCount = Math.max(
    ...severities.map((s) => data.incidentsBySeverity[s] || 0),
    1
  );

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <div className="mb-8 animate-in">
        <h1 className="text-2xl font-bold text-white">
          Dashboard
        </h1>
        <p className="mt-1" style={{ color: 'var(--sky-text-secondary)' }}>
          Office of Safeguards operations and canonical-template stewardship
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {/* SCSEM Updater */}
        {canManageCanonicalScsems && (
          <div className="glass-card rounded-xl p-6 slide-up stagger-1">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--sky-text-secondary)' }}>
              SCSEM Updater
            </span>
            <Shield className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-bold text-white">
              {scsemManifest.expectedWorkbookCount}
            </span>
            <span className="text-sm pb-1 text-emerald-400 flex items-center gap-1">
              Pinned workbooks
            </span>
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--sky-text-muted)' }}>
            Count from the reviewed IRS source manifest
          </p>
          </div>
        )}

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

        {/* SCSEM source policy */}
        {canManageCanonicalScsems && (
          <div className="glass-card rounded-xl p-6 slide-up stagger-3">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--sky-text-secondary)' }}>
              SCSEM Source Policy
            </span>
            <FileSpreadsheet className="w-5 h-5" style={{ color: 'var(--sky-blue)' }} />
          </div>
          <div className="text-xl font-bold text-white">
            {scsemSourcePolicy}
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--sky-text-muted)' }}>
            Each admitted workbook is pinned by byte size and SHA-256
          </p>
          </div>
        )}

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
          <p className="text-xs mt-3" style={{ color: 'var(--sky-text-muted)' }}>Safeguards queries</p>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* SCSEM candidate-workflow facts */}
        {canManageCanonicalScsems && (
          <div className="glass-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            SCSEM Candidate Workflow
          </h2>
          <dl className="space-y-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt style={{ color: 'var(--sky-text-secondary)' }}>Pinned IRS source set</dt>
              <dd className="font-semibold text-white text-right">
                {scsemManifest.expectedWorkbookCount} workbooks
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt style={{ color: 'var(--sky-text-secondary)' }}>Source policy</dt>
              <dd className="font-semibold text-white text-right">{scsemSourcePolicy}</dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt style={{ color: 'var(--sky-text-secondary)' }}>Source page reviewed</dt>
              <dd className="font-semibold text-white text-right">
                {scsemManifest.sourcePageReviewedAt}
              </dd>
            </div>
          </dl>
          <div className="mt-5 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
            <p className="text-sm font-semibold text-amber-200">Candidate only — human review required</p>
            <p className="mt-1 text-xs leading-5 text-amber-100/80">
              Benchmark matches and proposed edits require reviewer validation, workbook quality control, and release approval. They are not an automated claim that an update is available, that a template is current, or that any system is compliant.
            </p>
          </div>
          </div>
        )}

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

            {canManageCanonicalScsems && (
              <Link
                href="/scsems"
                className="flex items-center justify-between p-3 rounded-xl transition-all group"
                style={{ background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.15)' }}
              >
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-300">
                    Open SCSEM Updater
                  </span>
                </div>
                <ArrowRight className="w-4 h-4 text-emerald-400 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            )}
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
