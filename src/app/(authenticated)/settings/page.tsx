import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, getInitials } from "@/lib/utils";
import { Users, Mail, Shield, UserPlus } from "lucide-react";
import { UserManagement } from "@/components/user-management";
import { LLMSettings } from "@/components/llm-settings";
import { MfaSettings } from "@/components/mfa-settings";
import { isAdminRole, roleLabel } from "@/lib/roles";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ mfa?: string }>;
}) {
  const session = await auth();
  if (!session?.user) return null;
  const params = await searchParams;

  const userInfo = session.user as unknown as {
    id: string;
    role: string;
    organizationId: string;
  };
  const isAdmin = isAdminRole(userInfo.role);
  const orgId = userInfo.organizationId;

  let users: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    active: boolean;
    lastLogin: Date | null;
    createdAt: Date;
  }> = [];
  let org: { name: string; slug: string; createdAt: Date } | null = null;
  let pendingInvites: Array<{
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
  }> = [];
  let mfaStatus = {
    enabled: false,
    enabledAt: null as string | null,
    lastUsedAt: null as string | null,
    recoveryCodesRemaining: 0,
  };

  try {
    const [teamUsers, organization, invites, currentUserMfa, recoveryCount] =
      await Promise.all([
      db.user.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          lastLogin: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      db.organization.findUnique({
        where: { id: orgId },
        select: { name: true, slug: true, createdAt: true },
      }),
      db.invitation.findMany({
        where: { organizationId: orgId, used: false, expiresAt: { gt: new Date() } },
        select: { id: true, email: true, role: true, expiresAt: true },
        orderBy: { createdAt: "desc" },
      }),
      db.user.findUnique({
        where: { id: userInfo.id },
        select: {
          mfaEnabled: true,
          mfaEnabledAt: true,
          mfaLastUsedAt: true,
        },
      }),
      db.mfaRecoveryCode.count({
        where: { userId: userInfo.id, usedAt: null },
      }),
    ]);

    users = teamUsers;
    org = organization;
    pendingInvites = invites;
    mfaStatus = {
      enabled: currentUserMfa?.mfaEnabled ?? false,
      enabledAt: currentUserMfa?.mfaEnabledAt?.toISOString() ?? null,
      lastUsedAt: currentUserMfa?.mfaLastUsedAt?.toISOString() ?? null,
      recoveryCodesRemaining: recoveryCount,
    };
  } catch {
    // DB not available
  }

  const roleColors: Record<string, string> = {
    ADMIN: "bg-red-500/15 text-red-400",
    COMPUTER_SECURITY_REVIEW:
      "bg-emerald-500/15 text-emerald-300",
    COMPLIANCE_OFFICER:
      "bg-sky-500/15 text-sky-400",
    AUDITOR:
      "bg-violet-500/15 text-violet-400",
    VIEWER:
      "bg-[var(--sky-surface-overlay)] text-gray-700 bg-[var(--sky-surface-overlay)] text-[var(--sky-text-secondary)]",
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          User Management
        </h1>
        <p className="text-[var(--sky-text-secondary)] mt-1">
          {org?.name || "Organization"} &mdash; Manage users and roles
        </p>
      </div>

      <MfaSettings
        status={mfaStatus}
        setupRequested={params.mfa === "setup"}
      />

      {/* Admin sections */}
      {isAdmin && (
        <>
          <LLMSettings />
          <UserManagement orgId={orgId} />
        </>
      )}

      {/* Users Table */}
      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-[var(--sky-border)] flex items-center gap-2">
          <Users className="w-5 h-5 text-gray-500" />
          <h2 className="font-semibold text-white">
            Team Members ({users.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--sky-border)]">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Login
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--sky-border)]">
              {users.map((u) => (
                <tr
                  key={u.id}
                  className="hover:bg-white/[0.03] transition-colors"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-[var(--sky-royal)] flex items-center justify-center text-xs font-medium text-white">
                        {getInitials(u.name)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          {u.name}
                        </p>
                        <p className="text-xs text-gray-500">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex px-2.5 py-0.5 text-xs font-medium rounded-full ${roleColors[u.role] || roleColors.VIEWER}`}
                    >
                      {roleLabel(u.role)}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${u.active ? "text-emerald-400" : "text-gray-400"}`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${u.active ? "bg-green-500" : "bg-gray-400"}`}
                      />
                      {u.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {u.lastLogin ? formatDateTime(u.lastLogin) : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending Invitations */}
      {pendingInvites.length > 0 && (
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--sky-border)] flex items-center gap-2">
            <Mail className="w-5 h-5 text-gray-500" />
            <h2 className="font-semibold text-white">
              Pending Invitations ({pendingInvites.length})
            </h2>
          </div>
          <div className="divide-y divide-[var(--sky-border)]">
            {pendingInvites.map((inv) => (
              <div key={inv.id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm text-white">
                    {inv.email}
                  </p>
                  <p className="text-xs text-gray-500">
                    Expires {formatDateTime(inv.expiresAt)}
                  </p>
                </div>
                <span
                  className={`px-2.5 py-0.5 text-xs font-medium rounded-full ${roleColors[inv.role] || roleColors.VIEWER}`}
                >
                  {roleLabel(inv.role)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
