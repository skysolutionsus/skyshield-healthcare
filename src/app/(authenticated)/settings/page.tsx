import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, getInitials } from "@/lib/utils";
import { Users, Mail, Shield, UserPlus } from "lucide-react";
import { UserManagement } from "@/components/user-management";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) return null;

  const userInfo = session.user as unknown as {
    role: string;
    organizationId: string;
  };
  const isAdmin = userInfo.role === "ADMIN";
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

  try {
    [users, org, pendingInvites] = await Promise.all([
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
    ]);
  } catch {
    // DB not available
  }

  const roleColors: Record<string, string> = {
    ADMIN: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    COMPLIANCE_OFFICER:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    AUDITOR:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    VIEWER:
      "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          User Management
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          {org?.name || "Organization"} — Manage users and roles
        </p>
      </div>

      {/* Invite Section (Admin only) */}
      {isAdmin && <UserManagement orgId={orgId} />}

      {/* Users Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
          <Users className="w-5 h-5 text-gray-500" />
          <h2 className="font-semibold text-gray-900 dark:text-white">
            Team Members ({users.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800">
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
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {users.map((u) => (
                <tr
                  key={u.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-xs font-medium text-white">
                        {getInitials(u.name)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
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
                      {u.role.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${u.active ? "text-green-600 dark:text-green-400" : "text-gray-400"}`}
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
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
            <Mail className="w-5 h-5 text-gray-500" />
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Pending Invitations ({pendingInvites.length})
            </h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {pendingInvites.map((inv) => (
              <div key={inv.id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-900 dark:text-white">
                    {inv.email}
                  </p>
                  <p className="text-xs text-gray-500">
                    Expires {formatDateTime(inv.expiresAt)}
                  </p>
                </div>
                <span
                  className={`px-2.5 py-0.5 text-xs font-medium rounded-full ${roleColors[inv.role] || roleColors.VIEWER}`}
                >
                  {inv.role.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
