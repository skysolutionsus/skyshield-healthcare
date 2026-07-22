import { createHash, randomBytes } from "node:crypto";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_TOKEN_BYTES = 32;

export const USER_MANAGEMENT_ROLES = [
  "ADMIN",
  "COMPUTER_SECURITY_REVIEW",
  "COMPLIANCE_OFFICER",
  "AUDITOR",
  "VIEWER",
] as const;

export type UserManagementRole = (typeof USER_MANAGEMENT_ROLES)[number];

const USER_MANAGEMENT_ROLE_SET = new Set<string>(USER_MANAGEMENT_ROLES);

export function normalizeAccountEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function parseUserManagementRole(
  value: unknown
): UserManagementRole | null {
  return typeof value === "string" && USER_MANAGEMENT_ROLE_SET.has(value)
    ? (value as UserManagementRole)
    : null;
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Bind a JWT's MFA proof to the currently enrolled MFA secret generation. */
export function isMfaProofCurrent(
  mfaVerifiedAt: string | null | undefined,
  mfaEnabledAt: Date | string | null | undefined
): boolean {
  if (!mfaVerifiedAt || !mfaEnabledAt) return false;
  const verifiedAtMs = Date.parse(mfaVerifiedAt);
  const enabledAtMs =
    mfaEnabledAt instanceof Date
      ? mfaEnabledAt.getTime()
      : Date.parse(mfaEnabledAt);
  return (
    Number.isFinite(verifiedAtMs) &&
    Number.isFinite(enabledAtMs) &&
    verifiedAtMs >= enabledAtMs
  );
}

export function invitationTokenDigest(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Only the digest is stored in the database; the raw bearer token is returned once. */
export function generateInvitationToken(): {
  rawToken: string;
  tokenDigest: string;
} {
  const rawToken = randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
  return { rawToken, tokenDigest: invitationTokenDigest(rawToken) };
}

export function normalizeInvitationToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{40,128}$/.test(normalized) ? normalized : null;
}
