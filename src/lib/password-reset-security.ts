import { createHash, randomBytes } from "node:crypto";

const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export function passwordResetTokenDigest(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generatePasswordResetToken(): {
  rawToken: string;
  tokenDigest: string;
} {
  const rawToken = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
  return { rawToken, tokenDigest: passwordResetTokenDigest(rawToken) };
}

export function normalizePasswordResetToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{40,128}$/.test(normalized) ? normalized : null;
}
