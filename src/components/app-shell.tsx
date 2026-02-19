"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { SkyLogo } from "@/components/sky-logo";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "AI Agent", href: "/agent", icon: MessageSquare },
  { name: "SCSEM Library", href: "/scsems", icon: FileSpreadsheet },
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
  };
}

export function AppShell({ children, user }: AppShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--sky-navy)' }}>
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
          "fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-300 ease-out lg:translate-x-0 lg:static lg:z-auto",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{
          background: 'var(--sky-gradient-surface)',
          borderRight: '1px solid var(--sky-border)',
        }}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between px-5 py-4 shrink-0"
            style={{ borderBottom: '1px solid var(--sky-border)' }}
          >
            <SkyLogo size={48} />
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden transition-colors"
              style={{ color: 'var(--sky-text-muted)' }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto min-h-0">
            {navigation.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 relative group",
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
                  {user.role?.replace("_", " ")}
                </p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="transition-colors duration-200 hover:text-red-400"
                style={{ color: 'var(--sky-text-muted)' }}
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 glass"
          style={{ borderBottom: '1px solid var(--sky-border)' }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            style={{ color: 'var(--sky-text-secondary)' }}
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <SkyLogo size={20} />
            <span className="font-semibold text-white">
              SkyShield
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
