"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  LayoutDashboard,
  MessageSquare,
  FileSpreadsheet,
  AlertTriangle,
  ScrollText,
  Users,
  LogOut,
  Menu,
  X,
  Eye,
  EyeOff,
  ShieldAlert,
  ChevronDown,
  Database,
} from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { SkyLogo } from "@/components/sky-logo";
import { NotificationsMenu } from "@/components/notifications-menu";
import { isAdminRole, roleLabel } from "@/lib/roles";

const limitedNavigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "AI Agent", href: "/agent", icon: MessageSquare },
  { name: "SCSEM Updater", href: "/scsems", icon: FileSpreadsheet },
];

const adminNavigation = [
  ...limitedNavigation,
  { name: "Incidents", href: "/incidents", icon: AlertTriangle },
  { name: "Audit Log", href: "/audit-log", icon: ScrollText },
  { name: "Users", href: "/settings", icon: Users },
];

interface AppShellProps {
  children: React.ReactNode;
  user: {
    name?: string | null;
    email?: string | null;
    role?: string;
    canManageCanonicalScsems: boolean;
  };
}

interface ViewAsUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function AppShell({ children, user }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewAsUser, setViewAsUser] = useState<ViewAsUser | null>(null);
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [showViewAsDropdown, setShowViewAsDropdown] = useState(false);

  const isAdmin = isAdminRole(user.role);

  // Admin-only nav items
  const adminNavItems = isAdmin
    ? [
      {
        name: "Knowledge Base",
        href: "/knowledge",
        icon: Database,
      },
      {
        name: "False Positives",
        href: "/settings/false-positives",
        icon: ShieldAlert,
      },
    ]
    : [];

  const allNavItems = [
    ...(isAdmin ? adminNavigation : limitedNavigation),
    ...adminNavItems,
  ].filter(
    (item) => item.href !== "/scsems" || user.canManageCanonicalScsems
  );

  // Check view-as status on mount.
  useEffect(() => {
    if (!isAdmin) return;

    const controller = new AbortController();
    void fetch("/api/settings/view-as", { signal: controller.signal })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setViewAsUser(data.viewingAs || null);
      })
      .catch(() => {
        // Ignore network and cancellation errors.
      });

    return () => controller.abort();
  }, [isAdmin]);

  // Load org users for view-as dropdown
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const res = await fetch("/api/users");
        if (res.ok) {
          const data = await res.json();
          setOrgUsers(data.users || []);
        }
      } catch {
        // ignore
      }
    })();
  }, [isAdmin]);

  async function startViewAs(userId: string) {
    try {
      const res = await fetch("/api/settings/view-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        const data = await res.json();
        setViewAsUser(data.viewingAs);
        setShowViewAsDropdown(false);
        router.refresh();
      }
    } catch {
      // ignore
    }
  }

  async function stopViewAs() {
    try {
      const res = await fetch("/api/settings/view-as", {
        method: "DELETE",
      });
      if (res.ok) {
        setViewAsUser(null);
        router.refresh();
      }
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden" style={{ background: 'var(--sky-navy)' }}>
      {/* View-As Banner */}
      {viewAsUser && (
        <div className="z-50 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/15 px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-start gap-2 text-sm text-amber-400">
            <Eye className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Viewing as <strong>{viewAsUser.name}</strong> ({roleLabel(viewAsUser.role)})
            </span>
          </div>
          <button
            onClick={stopViewAs}
            className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg bg-amber-500/20 px-3 py-2 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/30"
          >
            <EyeOff className="w-3.5 h-3.5" />
            Exit View
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden transition-opacity"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-[calc(100vw_-_2rem)] max-w-72 transform transition-transform duration-300 ease-out sm:w-72 lg:static lg:z-auto lg:w-64 lg:translate-x-0",
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
          style={{
            background: 'var(--sky-gradient-surface)',
            borderRight: '1px solid var(--sky-border)',
          }}
        >
          <div className="flex h-full flex-col pb-[env(safe-area-inset-bottom)]">
            {/* Logo */}
            <div className="flex items-center justify-between px-6 py-6 shrink-0"
              style={{ borderBottom: '1px solid var(--sky-border)' }}
            >
              <div className="flex-1 flex justify-center lg:justify-start">
                <SkyLogo size={50} light={true} className="drop-shadow-[0_0_10px_rgba(33,150,243,0.15)]" />
              </div>

              <div className="hidden lg:block ml-auto">
                <NotificationsMenu />
              </div>

              <button
                onClick={() => setSidebarOpen(false)}
                className="ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors hover:bg-white/5 lg:hidden"
                style={{ color: 'var(--sky-text-muted)' }}
                aria-label="Close navigation"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto min-h-0">
              {allNavItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/dashboard" && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={cn(
                      "relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 group",
                      isActive
                        ? "text-white"
                        : "hover:text-white"
                    )}
                    style={{
                      color: isActive ? 'white' : 'var(--sky-text-muted)',
                      background: isActive ? 'rgba(33, 150, 243, 0.12)' : undefined,
                    }}
                  >
                    {/* Active indicator bar */}
                    {isActive && (
                      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full pulse-glow"
                        style={{ background: 'var(--sky-blue)' }}
                      />
                    )}
                    <item.icon className={cn(
                      "w-5 h-5 shrink-0 transition-colors duration-200",
                    )}
                      style={{ color: isActive ? 'var(--sky-light)' : undefined }}
                    />
                    {item.name}
                    {/* Hover glow effect */}
                    {!isActive && (
                      <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
                        style={{ background: 'rgba(33, 150, 243, 0.05)' }}
                      />
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* Footer */}
            <div className="p-4 space-y-3 shrink-0" style={{ borderTop: '1px solid var(--sky-border)' }}>
              {/* View As (Admin only) */}
              {isAdmin && !viewAsUser && (
                <div className="relative">
                  <button
                    onClick={() => setShowViewAsDropdown(!showViewAsDropdown)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--sky-surface-overlay)]"
                    style={{ color: 'var(--sky-text-muted)' }}
                  >
                    <div className="flex items-center gap-2">
                      <Eye className="w-3.5 h-3.5" />
                      View As User
                    </div>
                    <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showViewAsDropdown && "rotate-180")} />
                  </button>
                  {showViewAsDropdown && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-lg shadow-xl max-h-48 overflow-y-auto z-50">
                      {orgUsers.filter(u => u.role !== "ADMIN").length === 0 ? (
                        <p className="px-3 py-2 text-xs text-[var(--sky-text-muted)]">No other users</p>
                      ) : (
                        orgUsers
                          .filter(u => u.role !== "ADMIN")
                          .map((u) => (
                            <button
                              key={u.id}
                              onClick={() => startViewAs(u.id)}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--sky-surface-overlay)] transition-colors border-b border-[var(--sky-border)] last:border-b-0"
                            >
                              <p className="font-medium text-white truncate">{u.name}</p>
                              <p className="text-[var(--sky-text-muted)] truncate">{roleLabel(u.role)}</p>
                            </button>
                          ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* User info */}
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl glass">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white"
                  style={{ background: 'var(--sky-gradient-primary)' }}
                >
                  {user.name
                    ?.split(" ")
                    .map((n) => n[0])
                    .join("")
                    .toUpperCase()
                    .slice(0, 2) || "U"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {user.name}
                  </p>
                  <p className="text-xs truncate" style={{ color: 'var(--sky-text-muted)' }}>
                    {roleLabel(user.role)}
                  </p>
                </div>
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors duration-200 hover:bg-white/5 hover:text-red-400"
                  style={{ color: 'var(--sky-text-muted)' }}
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Mobile header */}
          <header className="glass flex shrink-0 items-center justify-between gap-2 px-3 py-2 lg:hidden sm:px-4"
            style={{ borderBottom: '1px solid var(--sky-border)' }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={() => setSidebarOpen(true)}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-white/5"
                style={{ color: 'var(--sky-text-secondary)' }}
                aria-label="Open navigation"
              >
                <Menu className="w-6 h-6" />
              </button>
              <div className="flex items-center gap-2">
                <SkyLogo size={12} light={true} />
                <span className="font-semibold text-white">
                  SkyShield
                </span>
              </div>
            </div>
            <NotificationsMenu />
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</main>
        </div>
      </div>
    </div>
  );
}
