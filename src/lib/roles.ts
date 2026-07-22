export const ADMIN_ROLE = "ADMIN";
export const COMPUTER_SECURITY_REVIEW_ROLE = "COMPUTER_SECURITY_REVIEW";

export const ADMIN_ACCESS_ROLES = new Set([ADMIN_ROLE]);

export const LIMITED_ACCESS_PREFIXES = [
  "/dashboard",
  "/agent",
  "/scsems",
  "/settings",
  "/api/dashboard",
  "/api/chat",
  "/api/mfa",
  "/api/scsems",
  "/api/scsem-updater",
];

export function roleLabel(role?: string | null): string {
  if (!role) return "User";
  if (role === "COMPUTER_SECURITY_REVIEW") return "Computer Security Review";
  return role
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export function isAdminRole(role?: string | null): boolean {
  return role === ADMIN_ROLE;
}

export function isScsemStewardRole(role?: string | null): boolean {
  return role === ADMIN_ROLE || role === COMPUTER_SECURITY_REVIEW_ROLE;
}

export function canAccessPath(role: string | undefined | null, pathname: string): boolean {
  if (isAdminRole(role)) return true;

  if (pathname === "/") return true;

  if (pathname === "/api/account/password") return true;

  if (
    pathname === "/scsems" ||
    pathname.startsWith("/scsems/") ||
    pathname === "/api/scsems" ||
    pathname.startsWith("/api/scsems/") ||
    pathname === "/api/scsem-updater" ||
    pathname.startsWith("/api/scsem-updater/")
  ) {
    return isScsemStewardRole(role);
  }

  return LIMITED_ACCESS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
