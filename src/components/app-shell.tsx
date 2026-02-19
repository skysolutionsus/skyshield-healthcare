"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Shield,
  LayoutDashboard,
  MessageSquare,
  FileSpreadsheet,
  AlertTriangle,
  ScrollText,
  Settings,
  Users,
  LogOut,
  Sun,
  Moon,
  Menu,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { cn } from "@/lib/utils";

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
  const { theme, setTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 dark:bg-gray-950 border-r border-gray-800 transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-800">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">IRS SkyShield</h1>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                Pub 1075 Compliance
              </p>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="ml-auto lg:hidden text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
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
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-blue-600/10 text-blue-400"
                      : "text-gray-400 hover:text-white hover:bg-gray-800"
                  )}
                >
                  <item.icon className="w-5 h-5 shrink-0" />
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* Footer */}
          <div className="border-t border-gray-800 p-4 space-y-3">
            {/* Theme toggle */}
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="flex items-center gap-3 px-3 py-2 w-full rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            >
              {theme === "dark" ? (
                <Sun className="w-5 h-5" />
              ) : (
                <Moon className="w-5 h-5" />
              )}
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </button>

            {/* User info */}
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-medium text-white">
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
                <p className="text-xs text-gray-500 truncate">
                  {user.role?.replace("_", " ")}
                </p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="text-gray-500 hover:text-red-400 transition-colors"
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
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-600 dark:text-gray-400"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-blue-600" />
            <span className="font-semibold text-gray-900 dark:text-white">
              SkyShield
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
