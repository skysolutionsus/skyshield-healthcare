import { compare, hash } from "bcryptjs";
import crypto from "crypto";

const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const normalized = Array.from({ length: 12 }, () => {
      const index = crypto.randomInt(RECOVERY_CODE_ALPHABET.length);
      return RECOVERY_CODE_ALPHABET[index];
    }).join("");

    return formatRecoveryCode(normalized);
  });
}

export async function hashRecoveryCodes(codes: string[]) {
  return Promise.all(codes.map((code) => hash(normalizeRecoveryCode(code), 12)));
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function findMatchingRecoveryCode({
  token,
  recoveryCodes,
}: {
  token: string;
  recoveryCodes: Array<{ id: string; codeHash: string; usedAt: Date | null }>;
}): Promise<string | null> {
  const normalized = normalizeRecoveryCode(token);
  if (normalized.length < 10) return null;

  for (const recoveryCode of recoveryCodes) {
    if (recoveryCode.usedAt) continue;

    if (await compare(normalized, recoveryCode.codeHash)) {
      return recoveryCode.id;
    }
  }

  return null;
}

function formatRecoveryCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}
