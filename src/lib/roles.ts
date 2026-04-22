export const ADMIN_ROLE = "ADMIN";
export const COMPUTER_SECURITY_REVIEW_ROLE = "COMPUTER_SECURITY_REVIEW";

export const ADMIN_ACCESS_ROLES = new Set([ADMIN_ROLE]);

export const LIMITED_ACCESS_PREFIXES = [
  "/dashboard",
  "/agent",
  "/scsems",
  "/api/dashboard",
  "/api/chat",
  "/api/scsems",
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

export function canAccessPath(role: string | undefined | null, pathname: string): boolean {
  if (isAdminRole(role)) return true;

  if (pathname === "/") return true;

  return LIMITED_ACCESS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
